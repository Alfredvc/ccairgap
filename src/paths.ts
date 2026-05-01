import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { realpathSync } from "node:fs";

/**
 * State root: CCAIRGAP_HOME > XDG_STATE_HOME/ccairgap > ~/.local/state/ccairgap.
 * If CCAIRGAP_HOME is set, both sessions/ and output/ live underneath it.
 */
export function stateRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCAIRGAP_HOME) return resolve(env.CCAIRGAP_HOME);
  const xdg = env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
  return join(xdg, "ccairgap");
}

export function sessionsDir(env?: NodeJS.ProcessEnv): string {
  return join(stateRoot(env), "sessions");
}

export function outputDir(env?: NodeJS.ProcessEnv): string {
  return join(stateRoot(env), "output");
}

export function sessionDir(id: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionsDir(env), id);
}

export function hostClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CONFIG_DIR) return env.CLAUDE_CONFIG_DIR;
  return join(env.HOME ?? homedir(), ".claude");
}

export function hostClaudeJson(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, ".claude.json");
  return join(env.HOME ?? homedir(), ".claude.json");
}

/** readlink -f equivalent. Throws if path doesn't exist. */
export function realpath(p: string): string {
  return realpathSync(p);
}

/**
 * Mirror of Claude Code's `sanitizePath` (upstream `src/utils/sessionStoragePortable.ts`):
 * replace every non-alphanumeric char with `-`. For paths whose sanitized form would
 * exceed MAX_SANITIZED_LENGTH (200), truncate and append `-<djb2(name).toString(36)>`.
 * djb2 (not Bun.hash) because ccairgap runs on Node — matches upstream's Node fallback.
 */
const MAX_SANITIZED_LENGTH = 200;

function djb2Hash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

export function encodeCwd(abs: string): string {
  const sanitized = abs.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  const hash = Math.abs(djb2Hash(abs)).toString(36);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
}
