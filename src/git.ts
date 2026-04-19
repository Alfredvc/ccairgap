import { statSync, readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";

/**
 * Resolve the real .git directory for a working tree path.
 * Handles:
 *  - plain repos: <path>/.git is a dir
 *  - worktrees: <path>/.git is a file containing `gitdir: <abs-or-rel>`
 *    pointing at main-repo/.git/worktrees/<name>/. Walk up to main-repo/.git/.
 * Returns absolute path to the main repo's .git/ dir.
 * Throws if <path> is not a git repo.
 */
export function resolveGitDir(repoPath: string): string {
  const dotGit = join(repoPath, ".git");
  let st;
  try {
    st = statSync(dotGit);
  } catch {
    throw new Error(`not a git repository: ${repoPath} (no .git)`);
  }

  if (st.isDirectory()) return dotGit;

  if (st.isFile()) {
    const contents = readFileSync(dotGit, "utf8");
    const match = contents.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!match || !match[1]) {
      throw new Error(`malformed .git file at ${dotGit}`);
    }
    const rawTarget = match[1];
    const worktreeDir = isAbsolute(rawTarget) ? rawTarget : resolve(repoPath, rawTarget);
    // worktreeDir = main-repo/.git/worktrees/<name>/
    // Walk up two levels: dirname(dirname(worktreeDir)) = main-repo/.git
    const worktreesDir = dirname(worktreeDir);
    const mainGitDir = dirname(worktreesDir);
    if (!existsSync(mainGitDir)) {
      throw new Error(`resolved main .git dir does not exist: ${mainGitDir}`);
    }
    return mainGitDir;
  }

  throw new Error(`unexpected .git type at ${dotGit}`);
}

/** `git clone --shared <src> <dest>` */
export async function gitCloneShared(src: string, dest: string): Promise<void> {
  await execa("git", ["clone", "--shared", src, dest], { stdio: "inherit" });
}

/** `git -C <repo> checkout -b <branch> [<base>]` */
export async function gitCheckoutNewBranch(
  repo: string,
  branch: string,
  base?: string,
): Promise<void> {
  const args = ["-C", repo, "checkout", "-b", branch];
  if (base) args.push(base);
  await execa("git", args, { stdio: "inherit" });
}

/** `git check-ref-format <ref>`. Returns true if the ref name is valid. */
export async function checkRefFormat(ref: string): Promise<boolean> {
  try {
    await execa("git", ["check-ref-format", ref], { reject: true });
    return true;
  } catch {
    return false;
  }
}

/** Returns true if `refs/heads/<branch>` exists in `repo`. */
export async function gitBranchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await execa(
      "git",
      ["-C", repo, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      { reject: true },
    );
    return true;
  } catch {
    return false;
  }
}

/** `git -C <realRepo> fetch <sessionClone> <branch>:<branch>`. Returns true on success. */
export async function gitFetchSandbox(
  realRepo: string,
  sessionClone: string,
  branch: string,
): Promise<boolean> {
  try {
    await execa("git", ["-C", realRepo, "fetch", sessionClone, `${branch}:${branch}`], {
      stdio: "inherit",
    });
    return true;
  } catch {
    return false;
  }
}

export interface GitIdentity {
  name?: string;
  email?: string;
}

/**
 * Read host git identity. Uses `git config --get user.{name,email}` from `cwd`
 * so repo-local config overrides global, matching git's own precedence.
 * Missing values returned as undefined (not an error — caller decides fallback).
 */
export async function readHostGitIdentity(cwd: string): Promise<GitIdentity> {
  const get = async (key: string): Promise<string | undefined> => {
    try {
      const { stdout } = await execa("git", ["config", "--get", key], { cwd, reject: false });
      const v = stdout.trim();
      return v.length > 0 ? v : undefined;
    } catch {
      return undefined;
    }
  };
  const [name, email] = await Promise.all([get("user.name"), get("user.email")]);
  return { name, email };
}

/** Count commits on `branch` that are not on `base` (for listing orphaned sessions). */
export async function countCommitsAhead(repo: string, branch: string, base: string): Promise<number> {
  try {
    const { stdout } = await execa("git", [
      "-C",
      repo,
      "rev-list",
      "--count",
      `${base}..${branch}`,
    ]);
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

export type DirtyStatus =
  | { kind: "clean" }
  | { kind: "dirty"; modified: number; untracked: number }
  | { kind: "scan-failed"; error: string };

/**
 * Scan a working tree for uncommitted changes.
 *
 * Definition of "dirty": `git status --porcelain` emits any non-empty line
 * (modifications, staged hunks, untracked non-ignored entries). Respects
 * `.gitignore`. A scan failure (git crashes, `.git/` missing) is returned
 * as a distinct `scan-failed` kind — callers err on preserve.
 *
 * Paths excluded from the scan via pathspec:
 *   .claude/ | .mcp.json | CLAUDE.md
 *
 * These are populated at launch by `overlayProjectClaudeConfig` — the session
 * clone receives the host working tree's version of each path, which would
 * otherwise flag every session as dirty and preserve it by default. The trade:
 * container-side edits to any of these paths are also invisible to the scan
 * and therefore lost on exit (acceptable — sandbox shouldn't evolve Claude
 * config across sessions).
 */
export async function dirtyTree(dir: string): Promise<DirtyStatus> {
  try {
    const { stdout } = await execa("git", [
      "-C",
      dir,
      "status",
      "--porcelain",
      "--",
      ".",
      ":(exclude).claude",
      ":(exclude).mcp.json",
      ":(exclude)CLAUDE.md",
    ]);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return { kind: "clean" };
    let modified = 0;
    let untracked = 0;
    for (const l of lines) {
      if (l.startsWith("??")) untracked++;
      else modified++;
    }
    return { kind: "dirty", modified, untracked };
  } catch (e) {
    return { kind: "scan-failed", error: (e as Error).message };
  }
}
