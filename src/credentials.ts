import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { hostClaudeDir } from "./paths.js";
import { refreshIfLowTtl, type RefreshResult } from "./authRefresh.js";

const KEYCHAIN_ITEM = "Claude Code-credentials";

/** 5-minute cold-start floor: Claude Code's own `isOAuthTokenExpired` buffer. */
const COLD_START_FLOOR_MS = 5 * 60 * 1000;

export interface CredentialSource {
  /** Absolute path to the file that should be bind-mounted at /host-claude-creds. */
  hostPath: string;
  /** Human-readable origin for doctor / logs. */
  origin: "keychain" | "file";
  /** Result of the pre-launch refresh attempt (or the "fresh" no-op). */
  refreshResult: RefreshResult;
  /** Authoritative remaining ttl after all refresh attempts. NaN when expiresAt absent. */
  finalTtlMs: number;
}

export interface ResolveCredentialsOptions {
  /** If host token ttl < this, attempt refresh. `0` disables. */
  refreshBelowMs: number;
}

/**
 * Thrown when host auth is dead (refresh failed + final ttl below the 5-min
 * cold-start floor). Caller exits 1 with a refusal banner. No session state
 * is mutated before this throws.
 */
export class CredentialsDeadError extends Error {
  readonly classification: string;
  readonly finalTtlMs: number;
  constructor(reason: string, classification: string, finalTtlMs: number) {
    super(reason);
    this.name = "CredentialsDeadError";
    this.classification = classification;
    this.finalTtlMs = finalTtlMs;
  }
}

async function readHostCredsJson(): Promise<string> {
  if (platform() === "darwin") {
    try {
      const { stdout } = await execa("security", [
        "find-generic-password",
        "-w",
        "-s",
        KEYCHAIN_ITEM,
      ]);
      return stdout;
    } catch (e) {
      throw new Error(
        `cannot read Claude Code credentials from macOS keychain (${(e as Error).message.split("\n")[0]}). ` +
          `Run \`claude\` on the host to log in, then unlock the login keychain.`,
      );
    }
  }
  const linuxPath = join(hostClaudeDir(), ".credentials.json");
  if (!existsSync(linuxPath)) {
    throw new Error(
      `host credentials missing at ${linuxPath}. Run \`claude\` on the host to log in.`,
    );
  }
  return readFileSync(linuxPath, "utf8");
}

/**
 * Remove `claudeAiOauth.refreshToken` from a creds JSON string. Preserves all
 * other fields. If the JSON is malformed or `claudeAiOauth` is missing, the
 * input is returned unchanged — parse failures surface elsewhere.
 */
export function stripRefreshToken(json: string): string {
  try {
    const obj = JSON.parse(json) as {
      claudeAiOauth?: Record<string, unknown>;
      [k: string]: unknown;
    };
    if (obj.claudeAiOauth && typeof obj.claudeAiOauth === "object") {
      const { refreshToken: _drop, ...rest } = obj.claudeAiOauth as Record<string, unknown>;
      obj.claudeAiOauth = rest;
    }
    return JSON.stringify(obj);
  } catch {
    return json;
  }
}

/**
 * Resolve the host credentials file for a session.
 * - Read host creds (macOS keychain / Linux file) into a JSON string.
 * - If host token ttl is low, run the `proper-lockfile`-coordinated refresh
 *   flow via `refreshIfLowTtl` (best-effort; see authRefresh.ts for details).
 * - If refresh failed AND final ttl < 5 min, throw `CredentialsDeadError`
 *   before writing any session state.
 * - Strip `claudeAiOauth.refreshToken` and materialize the result to
 *   `$sessionDir/creds/.credentials.json` (0600). The container's Claude Code
 *   never receives a refresh token, so it can't race host or peer containers.
 */
export async function resolveCredentials(
  sessionDir: string,
  opts: ResolveCredentialsOptions,
): Promise<CredentialSource> {
  // Probe-and-validate: fail fast on missing creds / keychain corruption /
  // missing `claudeAiOauth` before kicking off refresh. readHostCredsJson is
  // called again inside refreshIfLowTtl (pre-lock ttl probe) — the double read
  // is cheap and keeps refreshIfLowTtl self-contained.
  const initialJson = await readHostCredsJson();
  let initialParsed: { claudeAiOauth?: unknown };
  try {
    initialParsed = JSON.parse(initialJson) as { claudeAiOauth?: unknown };
  } catch (e) {
    throw new Error(`host credentials are not valid JSON: ${(e as Error).message}`);
  }
  if (!initialParsed.claudeAiOauth) {
    throw new Error("host credentials missing claudeAiOauth field");
  }

  const origin: CredentialSource["origin"] = platform() === "darwin" ? "keychain" : "file";
  const lockPath = hostClaudeDir();

  const refreshResult = await refreshIfLowTtl({
    lockPath,
    refreshBelowMs: opts.refreshBelowMs,
    readCreds: readHostCredsJson,
  });

  // Cold-start-dead refuse: ttl below the 5-min floor is a hard failure
  // regardless of whether refresh was attempted. Per spec CLI surface,
  // `--refresh-below-ttl 0` disables the refresh attempt but NOT this check.
  // NaN ttl (missing expiresAt) slips through — we can't assert deadness
  // when we don't know when the token expires.
  if (
    Number.isFinite(refreshResult.finalTtlMs) &&
    refreshResult.finalTtlMs < COLD_START_FLOOR_MS
  ) {
    const reason = refreshResult.ok
      ? "host token near expiry"
      : refreshResult.reason;
    const classification = refreshResult.ok ? "expired" : refreshResult.classification;
    throw new CredentialsDeadError(reason, classification, refreshResult.finalTtlMs);
  }

  const credsPath = join(sessionDir, "creds", ".credentials.json");
  mkdirSync(dirname(credsPath), { recursive: true });
  // `mode` on writeFileSync only applies at create time; chmod redundantly
  // enforces it against a pre-existing file (e.g. rerun of an aborted launch).
  writeFileSync(credsPath, stripRefreshToken(refreshResult.finalJson), { mode: 0o600 });
  chmodSync(credsPath, 0o600);

  return {
    hostPath: credsPath,
    origin,
    refreshResult,
    finalTtlMs: refreshResult.finalTtlMs,
  };
}

/**
 * Non-throwing variant for doctor. Returns ok + detail plus (when available)
 * the token's remaining ttl in ms and the space-separated scopes string. No
 * UUIDs, timestamps, or token material are exposed.
 */
export async function probeCredentials(): Promise<{
  ok: boolean;
  detail: string;
  ttlMs?: number;
  scopes?: string[];
}> {
  let json: string;
  try {
    json = await readHostCredsJson();
  } catch (e) {
    const msg = (e as Error).message;
    return { ok: false, detail: msg };
  }
  try {
    const parsed = JSON.parse(json) as {
      claudeAiOauth?: {
        expiresAt?: unknown;
        scopes?: unknown;
      };
    };
    if (!parsed.claudeAiOauth) {
      return { ok: false, detail: "host credentials missing claudeAiOauth field" };
    }
    const rawExpires = parsed.claudeAiOauth.expiresAt;
    const expiresAtMs =
      typeof rawExpires === "number"
        ? rawExpires
        : typeof rawExpires === "string" && rawExpires.length > 0
          ? Number(rawExpires)
          : undefined;
    const ttlMs =
      expiresAtMs !== undefined && Number.isFinite(expiresAtMs)
        ? expiresAtMs - Date.now()
        : undefined;
    const scopes = Array.isArray(parsed.claudeAiOauth.scopes)
      ? parsed.claudeAiOauth.scopes.filter((s): s is string => typeof s === "string")
      : undefined;
    const source =
      platform() === "darwin"
        ? `macOS keychain (${KEYCHAIN_ITEM})`
        : join(hostClaudeDir(), ".credentials.json");
    return { ok: true, detail: source, ttlMs, scopes };
  } catch (e) {
    return { ok: false, detail: `host credentials parse error: ${(e as Error).message}` };
  }
}

