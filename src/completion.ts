import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import {
  getShellFromEnv,
  install as tabtabInstall,
  isShellSupported,
  log as tabtabLog,
  parseEnv,
  uninstall as tabtabUninstall,
  type SupportedShell,
} from "@pnpm/tabtab";
import { encodeCwd, hostClaudeDir, realpath, sessionsDir } from "./paths.js";
import { listProjectSessions } from "./resumeResolver.js";

const PROGRAM_NAME = "ccairgap";

/** Session id directory listing. Read-only readdir — deliberately skips docker probe so completion stays fast. */
export function sessionIdCandidates(dir: string = sessionsDir()): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Custom titles of transcripts under the workspace's Claude projects dir.
 * Uses cwd as workspace when it's a git repo; returns [] otherwise. Completion
 * cannot parse `--repo` from an in-progress command line, so this is a best
 * effort for the common case (launch from the repo dir).
 */
export async function resumeNameCandidates(cwd: string = process.cwd()): Promise<string[]> {
  try {
    if (!existsSync(join(cwd, ".git"))) return [];
    const workspace = realpath(cwd);
    const encoded = encodeCwd(workspace);
    const hcd = realpath(hostClaudeDir());
    const projectDir = join(hcd, "projects", encoded);
    const sessions = await listProjectSessions(projectDir);
    return sessions
      .map((s) => s.customTitle)
      .filter((t): t is string => typeof t === "string" && t.length > 0);
  } catch {
    return [];
  }
}

/** Flat list of long-form option names (e.g. "--repo") for the default launch command. */
export function launchFlags(program: Command): string[] {
  return program.options.map((o) => o.long).filter((v): v is string => !!v);
}

/** Subcommand names minus the hidden completion-server callback. */
export function subcommandNames(program: Command): string[] {
  return program.commands
    .map((c) => c.name())
    .filter((n) => n !== "completion-server");
}

export async function installCompletion(shellArg?: string): Promise<void> {
  let shell: SupportedShell | undefined;
  if (shellArg !== undefined) {
    if (!isShellSupported(shellArg)) {
      throw new Error(
        `install-completion: unsupported shell '${shellArg}'. Supported: bash, zsh, fish.`,
      );
    }
    shell = shellArg;
  }
  await tabtabInstall({ name: PROGRAM_NAME, completer: PROGRAM_NAME, shell });
}

export async function uninstallCompletion(): Promise<void> {
  await tabtabUninstall({ name: PROGRAM_NAME });
}

/**
 * tabtab callback entry. Reads COMP_* env vars, picks candidates based on the
 * preceding word, and emits them via tabtab.log. Always exit 0 — completion
 * never surfaces errors to the shell prompt.
 */
export async function completionServer(program: Command): Promise<void> {
  try {
    const env = parseEnv(process.env);
    if (!env.complete) return;
    const shell = getShellFromEnv(process.env);

    const candidates = await candidatesFor(env.prev, program);
    tabtabLog(candidates, shell, console.log);
  } catch {
    // swallow — never render a stacktrace at tab-press time
  }
}

export async function candidatesFor(prev: string, program: Command): Promise<string[]> {
  if (prev === "recover" || prev === "discard") {
    return sessionIdCandidates();
  }
  if (prev === "-r" || prev === "--resume") {
    return resumeNameCandidates();
  }
  if (prev === "install-completion") {
    return ["bash", "zsh", "fish"];
  }
  return [...subcommandNames(program), ...launchFlags(program)];
}
