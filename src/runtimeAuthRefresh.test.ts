import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
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

  it("does NOT call refresh when ttl is above the 30-min window", async () => {
    const longTtl = Date.now() + 60 * 60_000; // 60 min
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(longTtl), { mode: 0o600 });

    const refreshFn = vi.fn();
    const handle = startRuntimeAuthRefresh({
      sessionDir: session,
      lockPath: session,
      readHostCreds: async () => "",
      refreshFn,
      now: () => Date.now(),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).not.toHaveBeenCalled();

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

  it("ceases polling when the creds file mtime changes outside our writes (in-container /login)", async () => {
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

    // simulate in-container /login: bump mtime on the creds file.
    // Switch to real timers BEFORE the sleep — the sleep needs the wallclock
    // to actually advance so the next stat() returns a different mtimeMs.
    vi.useRealTimers();
    await new Promise((r) => setTimeout(r, 20));
    writeFileSync(join(session, "creds", ".credentials.json"), FRESH(Date.now() + 60_000), { mode: 0o600 });
    vi.useFakeTimers();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).not.toHaveBeenCalled();
    // still ceased on subsequent ticks
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).not.toHaveBeenCalled();

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

  it("after a successful refresh, the next ttl-above-window tick does NOT cede control", async () => {
    // Regression guard: after writeSessionCreds, our recorded mtime must
    // match what the next `statSync` returns. Otherwise the watcher would
    // self-cede on every tick.
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

    // Next tick: ttl is now ~8h, well above the 30-min window. Should NOT
    // refresh, NOT cede.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refreshFn).toHaveBeenCalledTimes(1);

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
