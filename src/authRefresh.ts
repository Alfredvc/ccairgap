import { execa } from "execa";
import lockfile from "proper-lockfile";

/**
 * Auth-refresh pre-launch helper. Claude Code upstream refreshes OAuth access
 * tokens in place when `claudeAiOauth.expiresAt` drops below a 5-min buffer;
 * each refresh rotates the refresh token (RFC 9700 §4.13). If N ccairgap
 * containers each hold a private copy of `.credentials.json`, only the first
 * refresh wins and the rest receive `invalid_grant` → 401.
 *
 * This module runs ONCE on the host before launch, under a `proper-lockfile`
 * on `~/.claude/` (same library/path Claude Code uses at
 * `src/utils/auth.ts:1491`), and drives the supported
 * `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` fast-path
 * of `claude auth login` (upstream `cli/handlers/auth.ts:140-186`). Containers
 * subsequently receive a stripped creds file (no `refreshToken`) so they
 * never re-enter the refresh path.
 */

export type RefreshClassification =
  | "revoked"
  | "network"
  | "binary-missing"
  | "timeout"
  | "unknown";

export type RefreshAction = "fresh" | "already-fresh" | "refreshed";

export type RefreshResult =
  | {
      ok: true;
      action: RefreshAction;
      finalJson: string;
      finalTtlMs: number;
    }
  | {
      ok: false;
      reason: string;
      classification: RefreshClassification;
      finalJson: string;
      finalTtlMs: number;
    };

/** Injectable ops so unit tests can drive execa/lockfile/fs without touching disk. */
export interface RefreshIfLowTtlInput {
  /** Directory to acquire the proper-lockfile on. Must exist. */
  lockPath: string;
  /** Threshold (ms). If host ttl < this, attempt refresh. `0` disables. */
  refreshBelowMs: number;
  /**
   * Reads authoritative host credentials JSON (macOS keychain or Linux file).
   * Called once pre-lock, at least once in-lock, and once post-refresh.
   */
  readCreds: () => Promise<string>;
  /** Override for unit tests. Default: execa("claude", ["auth", "login"], …). */
  runAuthLogin?: (env: Record<string, string>) => Promise<void>;
  /** Override for unit tests. Default: proper-lockfile.lock. */
  acquireLock?: (path: string) => Promise<() => Promise<void>>;
  /** Override for unit tests. Default: Date.now. */
  now?: () => number;
}

interface ParsedCreds {
  refreshToken?: string;
  scopes?: string[];
  expiresAtMs?: number;
}

function parseCreds(json: string): ParsedCreds {
  try {
    const obj = JSON.parse(json) as {
      claudeAiOauth?: {
        refreshToken?: unknown;
        scopes?: unknown;
        expiresAt?: unknown;
      };
    };
    const oauth = obj.claudeAiOauth ?? {};
    const refreshToken =
      typeof oauth.refreshToken === "string" ? oauth.refreshToken : undefined;
    const scopes = Array.isArray(oauth.scopes)
      ? oauth.scopes.filter((s): s is string => typeof s === "string")
      : undefined;
    const rawExpires = oauth.expiresAt;
    const expiresAtMs =
      typeof rawExpires === "number"
        ? rawExpires
        : typeof rawExpires === "string" && rawExpires.length > 0
          ? Number(rawExpires)
          : undefined;
    return { refreshToken, scopes, expiresAtMs };
  } catch {
    return {};
  }
}

function computeTtlMs(creds: ParsedCreds, now: number): number {
  if (creds.expiresAtMs === undefined || !Number.isFinite(creds.expiresAtMs)) {
    return Number.NaN;
  }
  return creds.expiresAtMs - now;
}

function classifyFailure(e: unknown): {
  classification: RefreshClassification;
  reason: string;
} {
  const err = e as {
    code?: string;
    timedOut?: boolean;
    stderr?: string;
    shortMessage?: string;
    message?: string;
  };
  if (err.code === "ENOENT") {
    return { classification: "binary-missing", reason: "claude not on PATH" };
  }
  if (err.timedOut) {
    return {
      classification: "timeout",
      reason: "claude auth login timed out after 120s",
    };
  }
  const stderr = (err.stderr ?? "").toString();
  if (/invalid_grant/.test(stderr)) {
    return { classification: "revoked", reason: "refresh token revoked" };
  }
  if (/ENOTFOUND|ETIMEDOUT|ECONNREFUSED|getaddrinfo|network/i.test(stderr)) {
    return {
      classification: "network",
      reason: "network error contacting Anthropic",
    };
  }
  const firstLine = stderr.split("\n").find((l) => l.trim().length > 0);
  const reason = (firstLine ?? err.shortMessage ?? err.message ?? "unknown error").slice(0, 120);
  return { classification: "unknown", reason };
}

async function defaultRunAuthLogin(env: Record<string, string>): Promise<void> {
  await execa("claude", ["auth", "login"], {
    env: { ...process.env, ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
    reject: true,
  });
}

async function defaultAcquireLock(path: string): Promise<() => Promise<void>> {
  return lockfile.lock(path, {
    stale: 10_000,
    retries: {
      retries: 5,
      factor: 2,
      minTimeout: 100,
      maxTimeout: 2_000,
    },
    realpath: false,
  });
}

/**
 * Main entry. See module doc.
 *
 * Returns `{ ok: true, action: "fresh" }` without touching the lock when the
 * pre-lock ttl exceeds `refreshBelowMs`, `{ ok: true, action: "already-fresh" }`
 * when another writer refreshed while we waited for the lock, and
 * `{ ok: true, action: "refreshed" }` on a successful refresh. All failure
 * modes go through `classifyFailure` and return `{ ok: false, ... }` with the
 * authoritative post-attempt `finalJson` so the caller can still write a
 * stripped session creds file with whatever remaining ttl we have.
 */
export async function refreshIfLowTtl(
  input: RefreshIfLowTtlInput,
): Promise<RefreshResult> {
  const now = input.now ?? Date.now;
  const runAuthLogin = input.runAuthLogin ?? defaultRunAuthLogin;
  const acquireLock = input.acquireLock ?? defaultAcquireLock;

  // Initial (pre-lock) read.
  let json = await input.readCreds();
  let parsed = parseCreds(json);
  let ttl = computeTtlMs(parsed, now());

  const shouldTryRefresh = () =>
    input.refreshBelowMs > 0 &&
    Number.isFinite(ttl) &&
    ttl < input.refreshBelowMs &&
    parsed.refreshToken !== undefined;

  if (!shouldTryRefresh()) {
    return { ok: true, action: "fresh", finalJson: json, finalTtlMs: ttl };
  }

  const release = await acquireLock(input.lockPath);
  try {
    // In-lock re-read: another writer may have refreshed while we waited.
    json = await input.readCreds();
    parsed = parseCreds(json);
    ttl = computeTtlMs(parsed, now());

    if (!shouldTryRefresh()) {
      return {
        ok: true,
        action: "already-fresh",
        finalJson: json,
        finalTtlMs: ttl,
      };
    }

    const env: Record<string, string> = {
      CLAUDE_CODE_OAUTH_REFRESH_TOKEN: parsed.refreshToken ?? "",
    };
    if (parsed.scopes && parsed.scopes.length > 0) {
      env.CLAUDE_CODE_OAUTH_SCOPES = parsed.scopes.join(" ");
    }

    try {
      await runAuthLogin(env);
    } catch (e) {
      const { classification, reason } = classifyFailure(e);
      // Post-failure re-read so caller sees authoritative state (another
      // writer may have succeeded before us, or installOAuthTokens may have
      // partially completed and invalidated the original).
      try {
        json = await input.readCreds();
      } catch {
        // keep last good json if re-read fails
      }
      parsed = parseCreds(json);
      ttl = computeTtlMs(parsed, now());
      return {
        ok: false,
        reason,
        classification,
        finalJson: json,
        finalTtlMs: ttl,
      };
    }

    // Post-refresh re-read.
    json = await input.readCreds();
    parsed = parseCreds(json);
    ttl = computeTtlMs(parsed, now());
    return { ok: true, action: "refreshed", finalJson: json, finalTtlMs: ttl };
  } finally {
    try {
      await release();
    } catch {
      // lock already released or stale
    }
  }
}
