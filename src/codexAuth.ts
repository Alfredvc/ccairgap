import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const COLD_START_FLOOR_MS = 5 * 60 * 1000;
const LAST_REFRESH_MAX_AGE_MS = (7 * 24 + 23) * 60 * 60 * 1000;

export type CodexAuthMode = "selected" | "advisory";
export type CodexCredentialsStore = "file" | "keyring" | "auto" | "ephemeral";

export interface CodexAuthWarning {
  code: string;
  message: string;
  source?: string;
}

export interface CodexAuthPlan {
  ok: boolean;
  authJson?: string;
  authKind?: "api-key" | "chatgpt-token";
  warnings: CodexAuthWarning[];
}

export class CodexAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexAuthError";
    this.code = code;
  }
}

function failOrWarn(options: {
  selected: boolean;
  code: string;
  message: string;
  source?: string;
}): CodexAuthPlan {
  if (options.selected) throw new CodexAuthError(options.code, options.message);
  return {
    ok: false,
    warnings: [{ code: options.code, message: options.message, source: options.source }],
  };
}

function jwtExpiryMs(token: unknown): number | undefined {
  if (typeof token !== "string") return undefined;
  const part = token.split(".")[1];
  if (!part) return undefined;
  try {
    const padded = part.padEnd(Math.ceil(part.length / 4) * 4, "=");
    const payload = JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    const exp = payload?.exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeParsedAuth(parsed: unknown, nowMs: number, source?: string): CodexAuthPlan {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return failOrWarn({
      selected: true,
      code: "invalid-auth-json",
      message: "Codex auth.json must be a JSON object",
      source,
    });
  }
  const obj = parsed as Record<string, unknown>;

  if (typeof obj.OPENAI_API_KEY === "string" && obj.OPENAI_API_KEY.length > 0) {
    return {
      ok: true,
      authKind: "api-key",
      authJson: JSON.stringify({ OPENAI_API_KEY: obj.OPENAI_API_KEY }, null, 2) + "\n",
      warnings: [],
    };
  }

  if ("agent_identity" in obj) {
    throw new CodexAuthError(
      "unsupported-agent-identity",
      "Codex agent_identity auth contains private-key material and cannot be copied",
    );
  }

  const tokens = obj.tokens;
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) {
    throw new CodexAuthError("unsupported-auth", "Codex auth.json has no supported file auth");
  }
  const tokenObj = tokens as Record<string, unknown>;
  if (typeof obj.last_refresh !== "string" || obj.last_refresh.length === 0) {
    throw new CodexAuthError("refresh-required", "Codex token auth is missing last_refresh");
  }

  const expiryMs = jwtExpiryMs(tokenObj.access_token);
  if (expiryMs !== undefined && expiryMs - nowMs <= COLD_START_FLOOR_MS) {
    throw new CodexAuthError(
      "refresh-required",
      "Codex access token expires within the launch safety buffer",
    );
  }
  if (expiryMs === undefined) {
    const lastRefreshMs = Date.parse(obj.last_refresh);
    if (!Number.isFinite(lastRefreshMs)) {
      throw new CodexAuthError("refresh-required", "Codex last_refresh is not parseable");
    }
    if (nowMs - lastRefreshMs >= LAST_REFRESH_MAX_AGE_MS) {
      throw new CodexAuthError("refresh-required", "Codex last_refresh is too old");
    }
  }

  const sanitized = {
    auth_mode: obj.auth_mode,
    last_refresh: obj.last_refresh,
    tokens: {
      id_token: tokenObj.id_token,
      access_token: tokenObj.access_token,
      account_id: tokenObj.account_id,
      refresh_token: "",
    },
  };

  return {
    ok: true,
    authKind: "chatgpt-token",
    authJson: JSON.stringify(sanitized, null, 2) + "\n",
    warnings: [],
  };
}

export function sanitizeCodexAuthJson(options: {
  json: string;
  selected: boolean;
  nowMs?: number;
  source?: string;
}): CodexAuthPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(options.json);
  } catch (e) {
    return failOrWarn({
      selected: options.selected,
      code: "invalid-auth-json",
      message: `Codex auth.json is not valid JSON: ${(e as Error).message}`,
      source: options.source,
    });
  }

  try {
    return sanitizeParsedAuth(parsed, options.nowMs ?? Date.now(), options.source);
  } catch (e) {
    if (options.selected) throw e;
    const err = e as CodexAuthError;
    return {
      ok: false,
      warnings: [
        {
          code: err.code ?? "unsupported-auth",
          message: err.message,
          source: options.source,
        },
      ],
    };
  }
}

export function planCodexAuth(options: {
  hostHome: string;
  selected: boolean;
  credentialsStore?: CodexCredentialsStore;
  nowMs?: number;
}): CodexAuthPlan {
  const store = options.credentialsStore ?? "file";
  const authPath = join(options.hostHome, "auth.json");
  if (store === "keyring" || store === "ephemeral") {
    return failOrWarn({
      selected: options.selected,
      code: "unsupported-credentials-store",
      message: `Codex credentials store '${store}' is not supported in ccairgap`,
      source: authPath,
    });
  }
  if (!existsSync(authPath)) {
    return failOrWarn({
      selected: options.selected,
      code: "missing-auth-json",
      message: `Codex auth.json is missing at ${authPath}`,
      source: authPath,
    });
  }
  try {
    if (!statSync(authPath).isFile()) {
      return failOrWarn({
        selected: options.selected,
        code: "invalid-auth-json",
        message: `Codex auth path is not a regular file: ${authPath}`,
        source: authPath,
      });
    }
    return sanitizeCodexAuthJson({
      json: readFileSync(authPath, "utf8"),
      selected: options.selected,
      nowMs: options.nowMs,
      source: authPath,
    });
  } catch (e) {
    if (e instanceof CodexAuthError) throw e;
    return failOrWarn({
      selected: options.selected,
      code: "unreadable-auth-json",
      message: `Codex auth.json is unreadable: ${(e as Error).message}`,
      source: authPath,
    });
  }
}

export function writeCodexSessionAuth(sessionDir: string, authJson: string): string {
  const dest = join(sessionDir, "codex-auth", "auth.json");
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, authJson, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
  return dest;
}
