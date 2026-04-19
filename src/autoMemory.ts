import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { execaSync } from "execa";
import { readJsonOrNull } from "./hooks.js";

/** Port of Claude Code's djb2 hash (`claude-code/src/utils/hash.ts:7-13`). */
function djb2Hash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return hash;
}

/**
 * Port of Claude Code's `sanitizePath` (`claude-code/src/utils/sessionStoragePortable.ts:293-319`,
 * Node.js branch only).
 *
 * Replaces every non-alphanumeric char with `-`. If the sanitized result is
 * longer than 200 chars, truncates and appends `-<djb2(name).toString(36)>`.
 * The truncation branch is load-bearing for deep workspace paths — omitting
 * it would produce a host path Claude Code never wrote to, leading to a silent
 * empty mount (`existsSync` returns false, resolver falls through, user sees
 * "first session" memory emptiness despite having host memories).
 */
export const MAX_SANITIZED_LENGTH = 200;
export function sanitizePath(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  const hash = Math.abs(djb2Hash(name)).toString(36);
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${hash}`;
}

/**
 * Resolve the canonical repo root for a workspace path. Mirrors Claude Code's
 * `findCanonicalGitRoot` (`claude-code/src/utils/git.ts:185-210`) for the
 * common worktree case: `git rev-parse --git-common-dir` returns the main
 * repo's `.git` directory; its parent is the canonical root.
 *
 * For non-worktree repos the return value equals the input. For bare-repo
 * worktrees (common-dir basename !== `.git`), returns the common-dir itself
 * — matches Claude Code's line 174.
 *
 * Security: unlike Claude Code, we do not validate the gitfile backlink. The
 * attacker-worktree threat model only applies when cwd can be anywhere; ccairgap
 * only acts on paths the user explicitly passed via `--repo`.
 */
export function findCanonicalRepoRoot(workspaceHostPath: string): string {
  try {
    const { stdout } = execaSync(
      "git",
      ["-C", workspaceHostPath, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { reject: true },
    );
    const commonDir = stdout.trim();
    if (!commonDir) return workspaceHostPath;
    return basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  } catch {
    return workspaceHostPath;
  }
}

export interface ResolveAutoMemoryInput {
  /** Host Claude config home (honors `CLAUDE_CONFIG_DIR` — pass `hostClaudeDir(env)`). */
  hostClaudeDir: string;
  /** Realpath of the workspace repo (`repoEntries[0].hostPath`). */
  workspaceHostPath: string;
  /** Managed-policy dir from `resolveManagedPolicyDir()`; `undefined` when absent. */
  managedPolicyDir: string | undefined;
  /** Host home directory for `~/` expansion in settings values. */
  homeDir: string;
  /** Process env (inject in tests; use `process.env` in production). */
  env: NodeJS.ProcessEnv;
}

/**
 * Resolve the effective host auto-memory directory using the same precedence
 * Claude Code applies (`claude-code/src/memdir/paths.ts:161-235`):
 *
 *  1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var (absolute path; no tilde).
 *  2. `autoMemoryDirectory` in `<managedPolicyDir>/managed-settings.json`.
 *  3. `autoMemoryDirectory` in `<workspaceHostPath>/.claude/settings.local.json`.
 *  4. `autoMemoryDirectory` in `<hostClaudeDir>/settings.json`.
 *  5. Default: `<hostClaudeDir>/projects/<sanitizePath(workspaceHostPath)>/memory/`.
 *
 * `projectSettings` (`.claude/settings.json` committed to repo) is
 * intentionally skipped — matches Claude Code's security carve-out against
 * a malicious repo setting `autoMemoryDirectory: "~/.ssh"`.
 *
 * Returns `undefined` when the resolved path does not exist on disk, matching
 * our "mount only when source is present" convention.
 */
export function resolveAutoMemoryHostDir(i: ResolveAutoMemoryInput): string | undefined {
  const candidates: Array<() => string | undefined> = [
    () => validateEnvOverride(i.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE),
    () =>
      i.managedPolicyDir
        ? validateSettingsOverride(
            readAutoMemoryDirectory(join(i.managedPolicyDir, "managed-settings.json")),
            i.homeDir,
          )
        : undefined,
    () =>
      validateSettingsOverride(
        readAutoMemoryDirectory(join(i.workspaceHostPath, ".claude", "settings.local.json")),
        i.homeDir,
      ),
    () =>
      validateSettingsOverride(
        readAutoMemoryDirectory(join(i.hostClaudeDir, "settings.json")),
        i.homeDir,
      ),
  ];

  for (const c of candidates) {
    const resolved = c();
    if (resolved !== undefined) {
      return existsSync(resolved) ? resolved : undefined;
    }
  }

  const def = join(
    i.hostClaudeDir,
    "projects",
    sanitizePath(i.workspaceHostPath),
    "memory",
  );
  return existsSync(def) ? def : undefined;
}

function readAutoMemoryDirectory(path: string): unknown {
  const raw = readJsonOrNull(path);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  return (raw as { autoMemoryDirectory?: unknown }).autoMemoryDirectory;
}

function validateEnvOverride(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return validatePath(v, /* expandTilde */ false, /* homeDir */ "");
}

/** Mirror of Claude Code's `validateMemoryPath(raw, expandTilde)` (`claude-code/src/memdir/paths.ts:109-151`). */
function validateSettingsOverride(raw: unknown, homeDir: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  return validatePath(raw, /* expandTilde */ true, homeDir);
}

/**
 * Shared validation. Rejects: empty, bare-tilde forms, relative paths,
 * length < 3 after trailing-sep strip, Windows drive-only (`C:`), UNC
 * (`\\`/`//`), null bytes. Matches Claude Code line-for-line so the host-side
 * resolved path equals the path Claude Code itself would accept.
 */
function validatePath(raw: string, expandTilde: boolean, homeDir: string): string | undefined {
  if (!raw) return undefined;
  let candidate = raw;
  if (expandTilde && (candidate.startsWith("~/") || candidate.startsWith("~\\"))) {
    const rest = candidate.slice(2);
    const restNorm = normalize(rest || ".");
    if (restNorm === "." || restNorm === "..") return undefined;
    candidate = join(homeDir, rest);
  }
  const normalized = normalize(candidate).replace(/[/\\]+$/, "");
  if (
    !isAbsolute(normalized) ||
    normalized.length < 3 ||
    /^[A-Za-z]:$/.test(normalized) ||
    normalized.startsWith("\\\\") ||
    normalized.startsWith("//") ||
    normalized.includes("\0")
  ) {
    return undefined;
  }
  return normalized;
}
