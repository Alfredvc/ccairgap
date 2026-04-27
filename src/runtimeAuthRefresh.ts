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
  try {
    lastWriteMtimeMs = statSync(credsPath).mtimeMs;
  } catch {
    // creds file not yet present — first tick will skip via existsSync guard
  }
  // The session creds JSON has the same `expiresAt` as the host copy
  // (writeSessionCreds writes `stripRefreshToken(finalJson)`; only
  // `claudeAiOauth.refreshToken` is removed). Reading it here for the initial
  // wallclock gate is correct and avoids an extra keychain hit at startup.
  if (existsSync(credsPath)) {
    try {
      const json = readFileSyncSafe(credsPath);
      expiresAtMs = parseExpiresAt(json);
    } catch {
      // leave NaN — wallclock gate becomes "always run", and the first tick's
      // refreshFn call will pull authoritative state from the host
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

    // NaN guard: if we never learned an expiresAt (init read failed or the
    // file's expiresAt was malformed), do NOT enter the refresh path on every
    // tick — that would hammer the keychain. Skip; the first ok refresh
    // populates `expiresAtMs` for subsequent ticks.
    if (!Number.isFinite(expiresAtMs)) {
      // Try to read the session creds once more; if still NaN, skip.
      if (existsSync(credsPath)) {
        try {
          expiresAtMs = parseExpiresAt(readFileSyncSafe(credsPath));
        } catch {
          /* noop */
        }
      }
      if (!Number.isFinite(expiresAtMs)) return;
    }

    // Wallclock-based gate (catches sleep/suspend skew within one tick).
    if (now() < expiresAtMs - WINDOW_MS) return;

    // Mtime ownership check: if anything else (in-container /login, third-party
    // tool) wrote the creds file since our last write, cede control entirely.
    if (!existsSync(credsPath)) return;
    const currentMtime = statSync(credsPath).mtimeMs;
    if (Number.isFinite(lastWriteMtimeMs) && currentMtime !== lastWriteMtimeMs) {
      console.error(
        "ccairgap: creds file changed by another writer (likely in-container /login); pausing runtime refresh for this session",
      );
      stopped = true;
      return;
    }

    if (inflight) return; // re-entry while previous tick still running

    inflight = (async () => {
      const r = await refreshFn();
      if (r.ok) {
        writeSessionCreds(input.sessionDir, stripRefreshToken(r.finalJson));
        lastWriteMtimeMs = statSync(credsPath).mtimeMs;
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
    void tick();
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
