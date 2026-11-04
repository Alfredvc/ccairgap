import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** A linked worktree of a session clone, as host `git` can reach it. */
export interface LinkedWorktree {
  /** Path recorded by `git worktree add`, usually a container path. */
  recordedPath: string;
  /** Host path inside the session clone. Null when the worktree is outside the clone. */
  path: string | null;
  /** Branch from the worktree's HEAD. Null on a detached HEAD. */
  branch: string | null;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** The container wrote these files, and handoff runs on the host, so a symlink is hostile. */
function readRegularFile(path: string): string {
  if (!lstatSync(path).isFile()) throw new Error(`not a regular file: ${path}`);
  return readFileSync(path, "utf8");
}

function writeIfChanged(path: string, content: string): void {
  if (readRegularFile(path) !== content) writeFileSync(path, content);
}

/**
 * Enumerate the linked worktrees of a session clone and repoint them at the host.
 *
 * The container records absolute paths under `hostPath`, where it mounts the
 * clone. On the host, those paths are the real repo: its `.git/worktrees/<name>`
 * can exist with the same name. This rewrite makes `git -C <worktree>` safe on
 * the host, in the same way as the alternates rewrite. It is idempotent.
 *
 * Throws on a symlink in the admin data, or on a worktree that resolves outside
 * the clone. Callers treat a throw as a scan failure and preserve the session.
 * Do not call this while the session's container runs: the container needs the
 * recorded paths.
 */
export function prepareLinkedWorktrees(sessionClone: string, hostPath: string): LinkedWorktree[] {
  const adminRoot = join(sessionClone, ".git", "worktrees");
  if (!existsSync(adminRoot)) return [];

  const realClone = realpathSync(sessionClone);
  if (!isInside(realClone, realpathSync(adminRoot))) {
    throw new Error(`worktree admin dir leaves the session clone: ${adminRoot}`);
  }

  const out: LinkedWorktree[] = [];
  for (const entry of readdirSync(adminRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`symlink in worktree admin dir: ${entry.name}`);
    if (!entry.isDirectory()) continue;

    const adminDir = join(adminRoot, entry.name);
    const gitdirFile = join(adminDir, "gitdir");
    if (!existsSync(gitdirFile)) continue;

    const raw = readRegularFile(gitdirFile).trim();
    const dotGit = isAbsolute(raw) ? raw : resolve(adminDir, raw);
    const recordedPath = dirname(dotGit);
    const head = readRegularFile(join(adminDir, "HEAD")).trim();
    const branch = head.match(/^ref: refs\/heads\/(.+)$/)?.[1] ?? null;

    // Check the session clone first: a rewritten admin dir records that path.
    const mapped = isInside(sessionClone, recordedPath)
      ? recordedPath
      : isInside(hostPath, recordedPath)
        ? join(sessionClone, relative(hostPath, recordedPath))
        : null;

    if (mapped === null || basename(dotGit) !== ".git" || !existsSync(mapped)) {
      out.push({ recordedPath, path: null, branch });
      continue;
    }
    if (!isInside(realClone, realpathSync(mapped))) {
      throw new Error(`worktree leaves the session clone: ${mapped}`);
    }

    writeIfChanged(join(mapped, ".git"), `gitdir: ${adminDir}\n`);
    writeIfChanged(gitdirFile, `${join(mapped, ".git")}\n`);
    out.push({ recordedPath, path: mapped, branch });
  }
  return out;
}
