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
