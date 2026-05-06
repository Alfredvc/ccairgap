import {
  existsSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { writeSessionCreds } from "./sessionCredsWriter.js";
import { stripRefreshToken } from "./credentials.js";
import { refreshIfLowTtl, type RefreshResult } from "./authRefresh.js";

const TICK_MS = 60_000;
const WINDOW_MS = 30 * 60_000;
/** refreshIfLowTtl threshold — set above the schedule window so the in-lock
 *  re-read returns `already-fresh` when a peer ccairgap refreshed during our
 *  wait. Worded as `WINDOW_MS + TICK_MS` so future tuning of either constant
 *  stays consistent. */
const REFRESH_BELOW_MS = WINDOW_MS + TICK_MS;
const FAIL_BANNER_THRESHOLD = 3;
const TTL_BANNER_FLOOR_MS = 15 * 60_000;

/**
 * Tick every 60 s and call `refreshIfLowTtl` unconditionally. Two-fold purpose:
 *
 * 1. Pre-emptive token refresh when host ttl drops under `REFRESH_BELOW_MS`.
 *    `refreshIfLowTtl` short-circuits at `action: "fresh"` otherwise — one
 *    keychain read, no lock acquisition.
 * 2. Host-driven account swap propagation. When the host user runs `/login`
 *    and changes account, host creds rotate but the session creds file stays
 *    on the old token until natural expiry. Reading host creds every tick and
 *    writing on stripped-content diff propagates the new token to the
 *    bind-mounted session file within ≤60 s; upstream Claude Code's
 *    `invalidateOAuthCacheIfDiskChanged` (`auth.ts:1320`) picks it up on the
 *    next API request via the proactive `checkAndRefreshOAuthTokenIfNeeded`
 *    call in `services/api/client.ts:132`.
 *
 * Diff-write (vs. write-on-every-tick) avoids fsync churn on the steady-state
 * "host ttl high, no swap" case. The mtime ownership check still works because
 * we only update `lastWriteMtimeMs` when we actually write.
 */

export interface StartRuntimeAuthRefreshInput {
  /** $XDG_STATE_HOME/ccairgap/sessions/<id> — root for creds/, auth-warnings/, auth-refresh-state.json. */
  sessionDir: string;
  /** Host ~/.claude path the proper-lockfile gets acquired on. Must be the
   *  same realpath the pre-launch flow used (`launch.ts` realpath's
   *  `hostClaudeDir(env)` once and shares that value with both flows). */
  lockPath: string;
  /**
   * Reads authoritative host credentials JSON (macOS keychain or Linux file).
   * Production: `readHostCredsJson` from `credentials.ts`. The host file is the
   * only source carrying `claudeAiOauth.refreshToken` — `refreshIfLowTtl`
   * short-circuits at `parsed.refreshToken === undefined`, so reading the
   * stripped session copy here would silently disable refresh forever.
   */
  readHostCreds: () => Promise<string>;
  /** Injectable for tests. Defaults to the production `refreshIfLowTtl`
   *  bound against `readHostCreds` and `lockPath`. */
  refreshFn?: () => Promise<RefreshResult>;
  /** Defaults to Date.now. */
  now?: () => number;
}

export interface RuntimeAuthRefreshHandle {
  /** Clear the timer; await any in-flight refresh before resolving. */
  stop(): Promise<void>;
}

interface State {
  lastResult: "ok" | "fail";
  lastClassification: string | null;
  lastReason: string | null;
  lastFireMs: number;
  consecutiveFailures: number;
  expiresAtMs: number;
}

function parseExpiresAt(json: string): number {
  try {
    const obj = JSON.parse(json) as { claudeAiOauth?: { expiresAt?: unknown } };
    const raw = obj.claudeAiOauth?.expiresAt;
    if (typeof raw === "number") return raw;
    if (typeof raw === "string" && raw.length > 0) {
      const n = Number(raw);
      return Number.isFinite(n) ? n : Number.NaN;
    }
    return Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/** Atomic write for small status / banner files: tmp + rename. No fsync —
 *  these files are advisory; the creds file is the only target that gets
 *  fsync'd (see `sessionCredsWriter.ts`). */
function atomicWrite(path: string, contents: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

function readFileSyncSafe(path: string): string {
  return readFileSync(path, "utf8");
}

/** True iff the JSON has a non-empty `claudeAiOauth.refreshToken`. Used to
 *  distinguish in-container `/login` writes (full creds with refresh token)
 *  from host-side writes (always stripped). Malformed JSON → false. */
function externalHasRefreshToken(json: string): boolean {
  try {
    const obj = JSON.parse(json) as { claudeAiOauth?: { refreshToken?: unknown } };
    const rt = obj.claudeAiOauth?.refreshToken;
    return typeof rt === "string" && rt.length > 0;
  } catch {
    return false;
  }
}

export function startRuntimeAuthRefresh(
  input: StartRuntimeAuthRefreshInput,
): RuntimeAuthRefreshHandle {
  const now = input.now ?? Date.now;
  const refreshFn =
    input.refreshFn ??
    (() =>
      refreshIfLowTtl({
        lockPath: input.lockPath,
        refreshBelowMs: REFRESH_BELOW_MS,
        readCreds: input.readHostCreds,
      }));

  const credsPath = join(input.sessionDir, "creds", ".credentials.json");

  let stopped = false;
  let inflight: Promise<void> | undefined;
  let consecutiveFailures = 0;

  // Init reads: fail-soft on ENOENT / parse / stat error. The first tick
  // re-checks existence and skips if the file is gone.
  let lastWriteMtimeMs: number = Number.NaN;
  let expiresAtMs: number = Number.NaN;
  /** In-memory diff guard. Initialized from the session creds at startup
   *  (the pre-launch flow always materializes a stripped copy there). The
   *  watcher writes the session file only when `stripRefreshToken(host)` !==
   *  this value — keeps fsync churn off the steady-state path while still
   *  catching host-driven account swaps. */
  let lastWrittenStrippedJson: string | undefined;
  try {
    lastWriteMtimeMs = statSync(credsPath).mtimeMs;
  } catch {
    // Creds file not yet present at watcher start. Production invariant
    // (see `launch.ts` step 3 — `resolveCredentials` materializes
    // `$SESSION/creds/.credentials.json` *before* `startRuntimeAuthRefresh`)
    // means this branch never fires under the CLI; tests can hit it.
    // Consequence when it does fire: `lastWriteMtimeMs` stays NaN, the
    // `Number.isFinite` guard in the tick mtime-mismatch check fails, and
    // external writes are NOT detected until the first successful host-driven
    // refresh writes the file (which sets `lastWriteMtimeMs` to a finite
    // value). The `existsSync` guard in tick still skips when the file is
    // absent; it does not skip the rest of the tick once the file appears.
  }
  // The session creds JSON already has `refreshToken` stripped (pre-launch
  // flow uses `stripRefreshToken(finalJson)`), so its bytes are directly
  // comparable to `stripRefreshToken(host)` later.
  if (existsSync(credsPath)) {
    try {
      const json = readFileSyncSafe(credsPath);
      expiresAtMs = parseExpiresAt(json);
      lastWrittenStrippedJson = json;
    } catch {
      // leave undefined — first ok refresh will populate it
    }
  }

  const writeState = (result: "ok" | "fail", r?: RefreshResult): void => {
    const state: State = {
      lastResult: result,
      lastClassification: r && !r.ok ? r.classification : null,
      lastReason: r && !r.ok ? r.reason : null,
      lastFireMs: now(),
      consecutiveFailures,
      expiresAtMs,
    };
    atomicWrite(
      join(input.sessionDir, "auth-refresh-state.json"),
      JSON.stringify(state),
    );
  };

  const writeWarning = (): void => {
    // Use authoritative `expiresAtMs` directly (not `now() + finalTtlMs` — that
    // round-trip can drift by milliseconds and obscures the source of truth).
    const wallClock = Number.isFinite(expiresAtMs)
      ? new Date(expiresAtMs).toTimeString().slice(0, 5)
      : "??:??";
    const mins = Number.isFinite(expiresAtMs)
      ? Math.max(0, Math.round((expiresAtMs - now()) / 60_000))
      : 0;
    const text =
      `⚠ ccairgap: auth refresh has failed ${consecutiveFailures} times in a row.\n` +
      `  Token expires ${wallClock} (${mins}m). When it hits, run /login in Claude.`;
    atomicWrite(join(input.sessionDir, "auth-warnings", "current.txt"), text);
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;

    // Mtime mismatch check. Two writers other than us touch this file:
    //   1. In-container `/login` recovery — writes a FULL creds JSON with
    //      `refreshToken` set (Claude Code just completed OAuth in-container).
    //      Treated as an intentional account takeover for this session: we
    //      back off permanently so the watcher does not clobber the
    //      container-scoped refresh token with stripped host creds.
    //   2. Host-side writes — manual `cp` of fresh creds into the session
    //      file, third-party tools, etc. These never carry a `refreshToken`
    //      (the host-driven write path always strips). The watcher must
    //      continue watching: future host refreshes still need to propagate
    //      so `session creds == host creds (modulo refreshToken)` holds.
    // The two are distinguished by the presence of `claudeAiOauth.refreshToken`
    // in the externally-written file. mtime alone cannot tell them apart.
    if (!existsSync(credsPath)) return;
    const currentMtime = statSync(credsPath).mtimeMs;
    if (Number.isFinite(lastWriteMtimeMs) && currentMtime !== lastWriteMtimeMs) {
      let externalContent: string;
      try {
        externalContent = readFileSyncSafe(credsPath);
      } catch {
        // Race: file vanished between stat and read. Skip this tick; the
        // next existsSync check will retry.
        return;
      }
      if (externalHasRefreshToken(externalContent)) {
        console.error(
          "ccairgap: creds file rewritten with refreshToken (in-container /login); pausing runtime refresh for this session",
        );
        stopped = true;
        return;
      }
      // Host-side write detected — adopt as the new baseline and keep
      // watching. The next refreshFn pass will diff stripped-host against
      // this content and re-sync if they differ.
      lastWriteMtimeMs = currentMtime;
      lastWrittenStrippedJson = externalContent;
      expiresAtMs = parseExpiresAt(externalContent);
    }

    if (inflight) return; // re-entry while previous tick still running

    inflight = (async () => {
      let r: RefreshResult;
      try {
        r = await refreshFn();
      } catch (e) {
        // refreshFn throwing is the silent-failure path: `setInterval(() =>
        // void tick(), …)` discards rejections, so an unguarded readCreds
        // throw inside refreshIfLowTtl (e.g. locked macOS keychain after
        // sleep, missing claude binary on the watcher's PATH) used to vanish
        // without any state write — no warning, no doctor surface, no retry
        // counter. Classify as a generic failure and feed the existing
        // fail-banner / state-file path.
        consecutiveFailures += 1;
        const reason = ((e as Error | undefined)?.message ?? "unknown error").slice(0, 120);
        console.error(`ccairgap: token refresh threw (${reason}); retrying in 60s`);
        if (consecutiveFailures >= FAIL_BANNER_THRESHOLD) {
          writeWarning();
        }
        writeState("fail", {
          ok: false,
          reason,
          classification: "unknown",
          finalJson: "",
          finalTtlMs: Number.NaN,
        });
        return;
      }
      if (r.ok) {
        // Diff-write: skip fsync + mtime bump when host content unchanged
        // (steady-state refresh-not-needed path). This is the common case;
        // we only mutate the session file on a real refresh or a host-driven
        // account swap. Comparison is byte-exact stripped JSON — adequate
        // because both sides go through the same `stripRefreshToken` (which
        // is JSON.parse → JSON.stringify, deterministic for a given input).
        const stripped = stripRefreshToken(r.finalJson);
        if (stripped !== lastWrittenStrippedJson) {
          writeSessionCreds(input.sessionDir, stripped);
          lastWriteMtimeMs = statSync(credsPath).mtimeMs;
          lastWrittenStrippedJson = stripped;
        }
        expiresAtMs = parseExpiresAt(r.finalJson);
        consecutiveFailures = 0;
        writeState("ok", r);
      } else {
        consecutiveFailures += 1;
        // Don't update expiresAtMs — keep retrying every tick until success or threshold.
        console.error(
          `ccairgap: token refresh failed (${r.classification}): ${r.reason}; retrying in 60s`,
        );
        if (
          consecutiveFailures >= FAIL_BANNER_THRESHOLD ||
          (Number.isFinite(r.finalTtlMs) && r.finalTtlMs < TTL_BANNER_FLOOR_MS)
        ) {
          writeWarning();
        }
        writeState("fail", r);
      }
    })();
    try {
      await inflight;
    } finally {
      inflight = undefined;
    }
  };

  const interval = setInterval(() => {
    // Belt-and-suspenders against silent rejections. The IIFE-internal
    // try/catch around `refreshFn()` handles the canonical case (locked
    // keychain, missing claude binary), but `writeWarning()` / `writeState()`
    // inside the failure-handling path themselves call `atomicWrite`, which
    // can throw on a transient fs error (disk full, NFS hiccup, $SESSION
    // raced by handoff). Without this `.catch`, `void tick()` would swallow
    // that throw — the same class of silent-failure bug we are fixing.
    // The 60-s `setInterval` is unaffected by handler throws either way;
    // logging here just preserves observability.
    tick().catch((e) => {
      console.error(
        `ccairgap: auth-refresh tick crashed unexpectedly: ${(e as Error)?.message ?? e}`,
      );
    });
  }, TICK_MS);
  // Don't keep the event loop alive on the watcher alone.
  // (The docker-run child does that via stdio: "inherit".)
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      if (inflight) {
        try {
          await inflight;
        } catch {
          // soft failure; already classified
        }
      }
    },
  };
}
