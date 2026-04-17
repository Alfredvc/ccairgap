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

export function sessionDir(ts: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionsDir(env), ts);
}

export function hostClaudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".claude");
}

export function hostClaudeJson(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.HOME ?? homedir(), ".claude.json");
}

/** ISO 8601 compact UTC timestamp, e.g. 20260417T143022Z. */
export function compactTimestamp(d: Date = new Date()): string {
  const iso = d.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/** readlink -f equivalent. Throws if path doesn't exist. */
export function realpath(p: string): string {
  return realpathSync(p);
}

/** Encode an absolute cwd into the Claude transcripts dir name: /a/b/c -> -a-b-c. */
export function encodeCwd(abs: string): string {
  return abs.replace(/\//g, "-");
}
