import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRuntimeAuthRefresh } from "./runtimeAuthRefresh.js";
import type { RefreshResult } from "./authRefresh.js";

const FRESH = (expiresAtMs: number) =>
  JSON.stringify({
    claudeAiOauth: { accessToken: "at", expiresAt: expiresAtMs, scopes: ["user:inference"] },
  });

describe("startRuntimeAuthRefresh", () => {
  let session: string;

  beforeEach(() => {
    vi.useFakeTimers();
    session = mkdtempSync(join(tmpdir(), "ccairgap-runtime-auth-"));
    mkdirSync(join(session, "creds"));
    mkdirSync(join(session, "auth-warnings"));
  });

  afterEach(() => {
    rmSync(session, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("calls refresh every tick but does NOT rewrite the session creds when host content is unchanged", async () => {
    // Steady-state path: ttl high, host token == session token (modulo
    // refreshToken). refreshIfLowTtl returns `action: "fresh"` cheaply (one
    // keychain read, no lock). The watcher must NOT mutate the session file —
    // any write here would be a wasted fsync + mtime bump (the latter is
    // visible to upstream Claude Code via invalidateOAuthCacheIfDiskChanged).
    const longTtl = Date.now() + 60 * 60_000;
    const sessionJson = FRESH(longTtl);
    writeFileSync(join(session, "creds", ".credentials.json"), sessionJson, { mode: 0o600 });
    const mtimeBefore = statSync(join(session, "creds", ".credentials.json")).mtimeMs;

    const refreshFn = vi.fn(async (): Promise<RefreshResult> => ({
      ok: true,
      action: "fresh",
      finalJson: sessionJson, // host == session content
      finalTtlMs: 60 * 60_000,
    }));

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(2);

    const mtimeAfter = statSync(join(session, "creds", ".credentials.json")).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);

    await handle.stop();
  });

  it("propagates a host-driven account swap by writing new stripped creds to the session file", async () => {
    // User runs `/login` on the host, swaps to a different account. Host
    // creds rotate; the session file still has the old account's token.
    // Within ≤60 s the watcher must read host, see content has changed, and
    // write the new stripped creds. Container's mtime-check picks them up
    // on the next API request (auth.ts:1320).
    const longTtl = Date.now() + 60 * 60_000;
    const oldSession = JSON.stringify({
      claudeAiOauth: { accessToken: "old-at", expiresAt: longTtl, scopes: ["user:inference"] },
    });
    writeFileSync(join(session, "creds", ".credentials.json"), oldSession, { mode: 0o600 });

    const newAccountJson = JSON.stringify({
      claudeAiOauth: {
        accessToken: "new-account-at",
        // refreshToken stays in `r.finalJson` (host source); the watcher
        // strips it before writing.
        refreshToken: "new-account-rt",
        expiresAt: longTtl,
        scopes: ["user:inference"],
      },
    });

    const refreshFn = vi.fn(async (): Promise<RefreshResult> => ({
      ok: true,
      action: "fresh", // host ttl high; no actual refresh, just a keychain read
      finalJson: newAccountJson,
      finalTtlMs: 60 * 60_000,
    }));

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);

    const written = JSON.parse(
      readFileSync(join(session, "creds", ".credentials.json"), "utf8"),
    );
    expect(written.claudeAiOauth.accessToken).toBe("new-account-at");
    expect(written.claudeAiOauth.refreshToken).toBeUndefined();

    // Subsequent tick with same host content does NOT write again.
    const mtimeAfterSwap = statSync(join(session, "creds", ".credentials.json")).mtimeMs;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statSync(join(session, "creds", ".credentials.json")).mtimeMs).toBe(mtimeAfterSwap);

    await handle.stop();
  });

  it("calls refresh when ttl drops under the 30-min window", async () => {
    const shortTtl = Date.now() + 20 * 60_000; // 20 min
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(shortTtl), { mode: 0o600 });

    const newTtl = Date.now() + 8 * 60 * 60_000;
    const refreshFn = vi.fn(async (): Promise<RefreshResult> => ({
      ok: true,
      action: "refreshed",
      finalJson: FRESH(newTtl),
      finalTtlMs: newTtl - Date.now(),
    }));

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(1);

    const written = JSON.parse(
      readFileSync(join(session, "creds", ".credentials.json"), "utf8"),
    );
    expect(written.claudeAiOauth.expiresAt).toBe(newTtl);
    // refreshToken stripped on every host-driven write
    expect(written.claudeAiOauth.refreshToken).toBeUndefined();

    await handle.stop();
  });

  it("retries on the next tick after a failure (no exponential backoff)", async () => {
    const shortTtl = Date.now() + 20 * 60_000;
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(shortTtl), { mode: 0o600 });

    const refreshFn = vi
      .fn<() => Promise<RefreshResult>>()
      .mockResolvedValueOnce({
        ok: false,
        reason: "ENOTFOUND",
        classification: "network",
        finalJson: FRESH(shortTtl),
        finalTtlMs: 20 * 60_000,
      })
      .mockResolvedValueOnce({
        ok: true,
        action: "refreshed",
        finalJson: FRESH(Date.now() + 8 * 60 * 60_000),
        finalTtlMs: 8 * 60 * 60_000,
      });

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it("writes the loud-warning file at 3 consecutive failures", async () => {
    const shortTtl = Date.now() + 20 * 60_000;
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(shortTtl), { mode: 0o600 });

    const refreshFn = vi.fn(async (): Promise<RefreshResult> => ({
      ok: false,
      reason: "claude not on PATH",
      classification: "binary-missing",
      finalJson: FRESH(shortTtl),
      finalTtlMs: 20 * 60_000,
    }));

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    const warnFile = join(session, "auth-warnings", "current.txt");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(existsSync(warnFile)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(existsSync(warnFile)).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(existsSync(warnFile)).toBe(true);
    expect(readFileSync(warnFile, "utf8")).toMatch(/auth refresh has failed 3/);

    await handle.stop();
  });

  it("ceases polling when an external write carries a refreshToken (in-container /login)", async () => {
    // In-container `/login` writes a FULL creds JSON with refreshToken set.
    // Watcher must back off so host-driven writes don't clobber the
    // container-scoped refresh token.
    const shortTtl = Date.now() + 20 * 60_000;
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(shortTtl), { mode: 0o600 });

    const refreshFn = vi.fn();
    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    // Switch to real timers BEFORE the sleep — the sleep needs the wallclock
    // to actually advance so the next stat() returns a different mtimeMs.
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    const inContainerLogin = JSON.stringify({
      claudeAiOauth: {
        accessToken: "container-at",
        refreshToken: "container-rt",
        expiresAt: Date.now() + 60_000,
        scopes: ["user:inference"],
      },
    });
    writeFileSync(join(session, "creds", ".credentials.json"), inContainerLogin, { mode: 0o600 });
    vi.useFakeTimers();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).not.toHaveBeenCalled();
    // still ceased on subsequent ticks
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).not.toHaveBeenCalled();

    await handle.stop();
  });

  it("absorbs a host-side external write (no refreshToken) and keeps syncing host→session", async () => {
    // User did `cp <fresh creds> $SESSION/creds/.credentials.json` to recover
    // a stuck session, or a third-party tool touched the file. The injected
    // content is stripped (no refreshToken) — by definition, host-driven.
    // Watcher must adopt the new baseline (without ceding control) and keep
    // mirroring host so any future host update / refresh propagates.
    //
    // Pinning trick: pick `injectedJson === stripped(host)`. This is the
    // realistic case (host already had the new token; the user's manual `cp`
    // copied that exact stripped content, e.g. from a peer ccairgap session).
    // - WITHOUT the mtime peek: lastWrittenStrippedJson stays at `initialJson`,
    //   so on tick 1 `stripped(newHostJson) !== initialJson` → watcher rewrites
    //   the file, bumping mtime *again*.
    // - WITH the mtime peek: lastWrittenStrippedJson is updated to
    //   `injectedJson === stripped(newHostJson)`, so on tick 1 the diff guard
    //   correctly skips the write — the file mtime stays at the inject mtime.
    // Asserting "no rewrite after tick 1" pins the new code path: the
    // assertion fails if the mtime-peek branch is removed.
    const shortTtl = Date.now() + 20 * 60_000;
    const initialJson = FRESH(shortTtl);
    const credsFile = join(session, "creds", ".credentials.json");
    writeFileSync(credsFile, initialJson, { mode: 0o600 });

    // Host has refreshed; refreshFn returns the new host creds (with rt) on
    // every call. The watcher's diff guard compares `stripRefreshToken(host)`
    // against `lastWrittenStrippedJson`.
    const newHostExpiresAt = Date.now() + 8 * 60 * 60_000;
    const newHostJsonWithRt = JSON.stringify({
      claudeAiOauth: {
        accessToken: "host-at",
        refreshToken: "host-rt",
        expiresAt: newHostExpiresAt,
        scopes: ["user:inference"],
      },
    });
    // Stripped form — exactly what the watcher would write to the session
    // file, and exactly what the user injects.
    const strippedHost = JSON.stringify({
      claudeAiOauth: {
        accessToken: "host-at",
        expiresAt: newHostExpiresAt,
        scopes: ["user:inference"],
      },
    });

    const refreshFn = vi.fn(async (): Promise<RefreshResult> => ({
      ok: true,
      action: "fresh",
      finalJson: newHostJsonWithRt,
      finalTtlMs: newHostExpiresAt - Date.now(),
    }));

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    // Simulate host-side manual inject (the exact lofty-robin-820a recovery
    // action). Content has no refreshToken; mtime bumped via utimesSync for
    // deterministic / fast test (no real-clock sleep needed).
    writeFileSync(credsFile, strippedHost, { mode: 0o600 });
    const future = new Date(Date.now() + 5000);
    utimesSync(credsFile, future, future);
    const mtimeAfterInject = statSync(credsFile).mtimeMs;

    // Tick 1: mtime mismatch detected, no refreshToken in inject → adopt as
    // baseline, refreshFn fires, diff guard sees stripped host === baseline
    // → NO write. Asserting same mtime after tick 1 is the regression pin.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(statSync(credsFile).mtimeMs).toBe(mtimeAfterInject);
    const afterTick1 = JSON.parse(readFileSync(credsFile, "utf8"));
    expect(afterTick1.claudeAiOauth.expiresAt).toBe(newHostExpiresAt);
    expect(afterTick1.claudeAiOauth.refreshToken).toBeUndefined();

    // Tick 2: steady state. Watcher must NOT have stopped (would prove a
    // regression to "always cede on mtime change").
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(2);
    expect(statSync(credsFile).mtimeMs).toBe(mtimeAfterInject);

    await handle.stop();
  });

  it("absorbs a malformed-JSON external write without ceding (parse error → host-side fallthrough)", async () => {
    // `externalHasRefreshToken` returns false on JSON.parse failure. The
    // watcher must therefore treat torn / malformed external writes as
    // host-side (don't permanently cede); the next tick re-syncs from the
    // authoritative host creds. Important because a torn-write window
    // between writeFileSync and the watcher's stat→read pair is rare but
    // non-zero, and ceding on parse error would silently break recovery.
    const shortTtl = Date.now() + 20 * 60_000;
    const credsFile = join(session, "creds", ".credentials.json");
    writeFileSync(credsFile, FRESH(shortTtl), { mode: 0o600 });

    const newHostExpiresAt = Date.now() + 8 * 60 * 60_000;
    const refreshFn = vi.fn(async (): Promise<RefreshResult> => ({
      ok: true,
      action: "fresh",
      finalJson: FRESH(newHostExpiresAt),
      finalTtlMs: newHostExpiresAt - Date.now(),
    }));

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    // External write of malformed JSON (truncated mid-token).
    writeFileSync(credsFile, '{"claudeAiOauth":{"accessTok', { mode: 0o600 });
    const future = new Date(Date.now() + 5000);
    utimesSync(credsFile, future, future);

    // Watcher must NOT cede. refreshFn fires; the diff path overwrites
    // the malformed file with a valid stripped host JSON.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(1);
    const after = JSON.parse(readFileSync(credsFile, "utf8"));
    expect(after.claudeAiOauth.expiresAt).toBe(newHostExpiresAt);

    // Subsequent tick still fires (watcher is alive).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it("writes auth-refresh-state.json on every fire", async () => {
    const shortTtl = Date.now() + 20 * 60_000;
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(shortTtl), { mode: 0o600 });

    const refreshFn = vi.fn(async (): Promise<RefreshResult> => ({
      ok: true,
      action: "refreshed",
      finalJson: FRESH(Date.now() + 8 * 60 * 60_000),
      finalTtlMs: 8 * 60 * 60_000,
    }));

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const state = JSON.parse(readFileSync(join(session, "auth-refresh-state.json"), "utf8"));
    expect(state.lastResult).toBe("ok");
    expect(state.consecutiveFailures).toBe(0);

    await handle.stop();
  });

  it("after a successful refresh, the next tick does NOT cede control", async () => {
    // Regression guard: after writeSessionCreds, our recorded mtime must
    // match what the next `statSync` returns. Otherwise the watcher would
    // self-cede on every tick. With the diff-write change, refreshFn fires
    // on every tick — cede would manifest as refreshFn never being called
    // on tick 2.
    const shortTtl = Date.now() + 20 * 60_000;
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(shortTtl), { mode: 0o600 });

    const newExpiresAt = Date.now() + 8 * 60 * 60_000;
    const refreshFn = vi.fn(async (): Promise<RefreshResult> => ({
      ok: true,
      action: "refreshed",
      finalJson: FRESH(newExpiresAt),
      finalTtlMs: newExpiresAt - Date.now(),
    }));

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(1);

    // Next tick: same host content. refreshFn still called (no wallclock
    // gate), but no write happens (diff guard). Cede must NOT fire.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(2);

    await handle.stop();
  });

  it("default refreshFn calls real refreshIfLowTtl with the host-creds reader (refreshes when host carries refreshToken)", async () => {
    // The most important integration test: the production wiring uses
    // refreshIfLowTtl, which short-circuits at parsed.refreshToken === undefined.
    // This test asserts the watcher is wired against a host-creds reader that
    // INCLUDES refreshToken — without that, refresh silently never happens.
    const shortTtl = Date.now() + 20 * 60_000;
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(shortTtl), { mode: 0o600 });

    const HOST_JSON_WITH_RT = JSON.stringify({
      claudeAiOauth: {
        accessToken: "host-at",
        refreshToken: "host-rt",
        expiresAt: shortTtl,
        scopes: ["user:inference"],
      },
    });
    const HOST_JSON_REFRESHED = JSON.stringify({
      claudeAiOauth: {
        accessToken: "new-host-at",
        refreshToken: "new-host-rt",
        expiresAt: Date.now() + 8 * 60 * 60_000,
        scopes: ["user:inference"],
      },
    });

    const readHostCreds = vi
      .fn<() => Promise<string>>()
      .mockResolvedValueOnce(HOST_JSON_WITH_RT) // pre-lock probe
      .mockResolvedValueOnce(HOST_JSON_WITH_RT) // in-lock re-read
      .mockResolvedValueOnce(HOST_JSON_REFRESHED); // post-refresh re-read

    const runAuthLogin = vi.fn(async () => {
      // pretend `claude auth login` rotated the token on the host
    });
    const acquireLock = vi.fn(async () => async () => {
      /* release */
    });

    const { refreshIfLowTtl } = await import("./authRefresh.js");
    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds,
      refreshFn: () =>
        refreshIfLowTtl({
          lockPath: session,
          refreshBelowMs: 31 * 60_000,
          readCreds: readHostCreds,
          runAuthLogin,
          acquireLock,
          now: Date.now,
        }),
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(runAuthLogin).toHaveBeenCalledTimes(1);
    const stripped = JSON.parse(readFileSync(join(session, "creds", ".credentials.json"), "utf8"));
    expect(stripped.claudeAiOauth.accessToken).toBe("new-host-at");
    expect(stripped.claudeAiOauth.refreshToken).toBeUndefined();

    await handle.stop();
  });

  it("records a fail state when refreshFn throws (silent-rejection guard)", async () => {
    // Regression for the silent unhandled-rejection bug: refreshIfLowTtl's
    // initial readCreds() is unguarded; a locked macOS keychain (or any
    // throw) used to propagate out of `void tick()` and vanish — no state
    // write, no banner, no retry counter increment. Watcher must convert a
    // throw into a "fail" state with classification "unknown" and increment
    // consecutiveFailures so doctor / loud-banner / observability work.
    const shortTtl = Date.now() + 20 * 60_000;
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(shortTtl), { mode: 0o600 });

    const refreshFn = vi.fn(async (): Promise<RefreshResult> => {
      throw new Error("security: User interaction is not allowed.");
    });

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    const stateAfter1 = JSON.parse(
      readFileSync(join(session, "auth-refresh-state.json"), "utf8"),
    );
    expect(stateAfter1.lastResult).toBe("fail");
    expect(stateAfter1.lastClassification).toBe("unknown");
    expect(stateAfter1.lastReason).toMatch(/User interaction is not allowed/);
    expect(stateAfter1.consecutiveFailures).toBe(1);

    // Retry semantics: next tick fires again, counter increments.
    await vi.advanceTimersByTimeAsync(60_000);
    const stateAfter2 = JSON.parse(
      readFileSync(join(session, "auth-refresh-state.json"), "utf8"),
    );
    expect(stateAfter2.consecutiveFailures).toBe(2);
    expect(refreshFn).toHaveBeenCalledTimes(2);

    // 3rd consecutive throw trips the loud-warning file (same threshold as
    // the existing classified-fail path).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(existsSync(join(session, "auth-warnings", "current.txt"))).toBe(true);

    await handle.stop();
  });

  it("stop() awaits an inflight refresh", async () => {
    const shortTtl = Date.now() + 20 * 60_000;
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(shortTtl), { mode: 0o600 });

    let resolveRefresh: ((r: RefreshResult) => void) | undefined;
    const refreshFn = vi.fn(
      () =>
        new Promise<RefreshResult>((resolve) => {
          resolveRefresh = resolve;
        }),
    );

    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(1);

    let stopped = false;
    const stopPromise = handle.stop().then(() => {
      stopped = true;
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);

    resolveRefresh?.({
      ok: true,
      action: "refreshed",
      finalJson: FRESH(Date.now() + 8 * 60 * 60_000),
      finalTtlMs: 8 * 60 * 60_000,
    });
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
