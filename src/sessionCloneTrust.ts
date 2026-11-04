import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { checkRefFormat, resolveGitDir } from "./git.js";
import { mapRecordedPath } from "./worktrees.js";

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// A hook path from the user's global config must not see this rebuild.
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];
/** Left where a nested `.git` was. It keeps the directory visible to the dirty scan. */
export const MOVED_GIT_NOTE = ".ccairgap-moved-git";

function stateDir(sessionDir: string, name: string): string {
  return join(sessionDir, "sanitized-git", name);
}

/** True when host `git` commands are safe in this clone. The container cannot see this marker. */
export function isSessionCloneSanitized(sessionDir: string, name: string): boolean {
  return existsSync(join(stateDir(sessionDir, name), "done"));
}

function assertRealDir(path: string): void {
  if (!lstatSync(path).isDirectory()) throw new Error(`not a real directory: ${path}`);
}

/** `lstat` first, because a symlink could name any host file. */
function readRegularFile(path: string): string {
  if (!lstatSync(path).isFile()) throw new Error(`not a regular file: ${path}`);
  return readFileSync(path, "utf8").trim();
}

async function git(gitDir: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa("git", [...NO_HOOKS, `--git-dir=${gitDir}`, ...args]);
  return stdout;
}

/** Replace the alternates file without writing through a symlink. */
function replaceAlternates(gitDir: string, objectsDir: string): void {
  const objects = join(gitDir, "objects");
  assertRealDir(objects);
  const info = join(objects, "info");
  if (existsSync(info) || lstatExists(info)) assertRealDir(info);
  else mkdirSync(info);
  const file = join(info, "alternates");
  rmSync(file, { force: true });
  writeFileSync(file, `${objectsDir}\n`, { flag: "wx" });
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function validatedHead(text: string): Promise<{ ref: string } | { sha: string }> {
  const ref = text.match(/^ref: (refs\/heads\/.+)$/)?.[1];
  if (ref && (await checkRefFormat(ref))) return { ref };
  if (SHA.test(text)) return { sha: text };
  throw new Error(`invalid HEAD: ${JSON.stringify(text.slice(0, 200))}`);
}

/**
 * Rebuild the admin dirs of linked worktrees. Only validated text crosses over.
 * Returns each worktree's `.git` path in the clone, with its admin dir's final path.
 */
async function rebuildWorktreeAdmins(
  untrusted: string,
  rebuilt: string,
  sessionClone: string,
  hostPath: string,
): Promise<Map<string, string>> {
  const worktrees = new Map<string, string>();
  const adminRoot = join(untrusted, "worktrees");
  if (!lstatExists(adminRoot)) return worktrees;
  assertRealDir(adminRoot);

  for (const entry of readdirSync(adminRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`symlink in worktree admin dir: ${entry.name}`);
    if (!entry.isDirectory()) continue;
    const admin = join(adminRoot, entry.name);
    if (!lstatExists(join(admin, "gitdir"))) continue;

    const recorded = readRegularFile(join(admin, "gitdir"));
    if (/[\x00-\x1f\x7f]/.test(recorded)) throw new Error(`invalid worktree path in ${entry.name}`);
    const head = await validatedHead(readRegularFile(join(admin, "HEAD")));
    // A relative path is relative to the admin dir at its original location.
    const original = join(sessionClone, ".git", "worktrees", entry.name);
    const gitdir = isAbsolute(recorded) ? recorded : resolve(original, recorded);

    const target = join(rebuilt, "worktrees", entry.name);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "commondir"), "../..\n");
    writeFileSync(join(target, "gitdir"), `${gitdir}\n`);
    writeFileSync(join(target, "HEAD"), "ref" in head ? `ref: ${head.ref}\n` : `${head.sha}\n`);
    // A missing commit leaves no index. `git status` then fails, and handoff preserves.
    await git(target, "read-tree", "HEAD").catch(() => undefined);

    const mapped = mapRecordedPath(sessionClone, hostPath, dirname(gitdir));
    if (mapped !== null && basename(gitdir) === ".git") {
      worktrees.set(join(mapped, ".git"), original);
    }
  }
  return worktrees;
}

/**
 * Clear every `.git` below the working tree, except the clone's own.
 *
 * The rebuild does not cover these. Plain `git status` and `git add -A` in the
 * clone run the config of a repo at a gitlink path, and `git add -A` turns an
 * untracked nested repo into a gitlink. A linked worktree's `.git` file stays,
 * with a host-written target. Any other `.git` moves to `nested-git/`.
 *
 * The walk does not follow symlinks. Names compare in lower case, because a
 * case-insensitive filesystem resolves `.GIT` as `.git`.
 */
function clearNestedGit(sessionClone: string, root: string, worktrees: Map<string, string>): void {
  const moved = join(root, "nested-git");
  const pending = [sessionClone];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.name.toLowerCase() !== ".git") {
        if (entry.isDirectory()) pending.push(path);
        continue;
      }
      if (path === join(sessionClone, ".git")) continue;

      const admin = worktrees.get(path);
      if (admin !== undefined && entry.isFile()) {
        writeFileSync(path, `gitdir: ${admin}\n`);
        continue;
      }

      const rel = relative(sessionClone, path);
      const target = join(moved, createHash("sha256").update(rel).digest("hex").slice(0, 16));
      mkdirSync(moved, { recursive: true });
      // rmSync removes a symlink itself, and it throws on a directory.
      rmSync(join(dir, MOVED_GIT_NOTE), { force: true });
      writeFileSync(
        join(dir, MOVED_GIT_NOTE),
        `ccairgap moved the git data of this directory to ${target}.\n` +
          `Submodule data can be under ${join(root, "untrusted-git", "modules")}.\n` +
          `Do not run git in those directories: their config and hooks can run commands.\n`,
        { flag: "wx" },
      );
      renameSync(path, target);
    }
  }
}

/**
 * Replace a session clone's container-written `.git` with a host-created one.
 *
 * `git(1)` §SECURITY: Git commands in an untrusted `.git` can run commands from
 * its config and hooks, and `upload-pack` is restricted so that fetching from
 * one is safe. This function opens the old `.git` only through `git fetch`, and
 * as validated text. It also moves every nested `.git` out of the working tree.
 * Afterwards any host `git` command in the clone is safe.
 *
 * Idempotent, and it resumes after a crash. Throws when the clone cannot be
 * made safe: callers must then run no other `git` command in it and must
 * preserve the session. Call it only after the session's container has stopped.
 */
export async function sanitizeSessionClone(opts: {
  sessionDir: string;
  name: string;
  sessionClone: string;
  hostPath: string;
}): Promise<void> {
  const { sessionDir, name, sessionClone, hostPath } = opts;
  if (isSessionCloneSanitized(sessionDir, name)) return;

  const root = stateDir(sessionDir, name);
  const untrusted = join(root, "untrusted-git");
  const rebuilt = join(root, "rebuilt-git");
  const dotGit = join(sessionClone, ".git");
  mkdirSync(root, { recursive: true });

  if (lstatExists(untrusted)) {
    // A crash after the move below. Any `.git` here came from this function.
    rmSync(dotGit, { recursive: true, force: true });
  } else {
    assertRealDir(dotGit);
    renameSync(dotGit, untrusted);
  }
  if (lstatExists(join(untrusted, "commondir"))) {
    throw new Error("`.git` has a commondir file, which only a linked worktree should have");
  }

  const hostObjects = join(resolveGitDir(hostPath), "objects");
  replaceAlternates(untrusted, hostObjects);

  const { stdout: objectFormat } = await execa("git", [
    "-C",
    hostPath,
    "rev-parse",
    "--show-object-format",
  ]);
  rmSync(rebuilt, { recursive: true, force: true });
  await execa("git", [
    ...NO_HOOKS,
    "init",
    "-q",
    "--bare",
    "--template=",
    `--object-format=${objectFormat}`,
    rebuilt,
  ]);
  replaceAlternates(rebuilt, hostObjects);

  await git(
    rebuilt,
    "fetch",
    "--quiet",
    "--no-tags",
    "--no-recurse-submodules",
    "--update-shallow",
    "--update-head-ok",
    untrusted,
    "+refs/*:refs/*",
  );

  const head = await validatedHead(readRegularFile(join(untrusted, "HEAD")));
  if ("ref" in head) {
    await git(rebuilt, "symbolic-ref", "HEAD", head.ref);
  } else {
    await git(rebuilt, "fetch", "--quiet", "--no-tags", "--no-recurse-submodules", untrusted, "HEAD");
    await git(rebuilt, "update-ref", "--no-deref", "HEAD", head.sha);
  }

  await git(rebuilt, "config", "core.bare", "false");
  await git(rebuilt, "config", "core.logAllRefUpdates", "true");
  await git(rebuilt, "config", "remote.origin.url", hostPath);
  await git(rebuilt, "config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  // An unborn HEAD has no tree to read, and the index stays empty.
  await git(rebuilt, "read-tree", "HEAD").catch(() => undefined);

  const worktrees = await rebuildWorktreeAdmins(untrusted, rebuilt, sessionClone, hostPath);

  renameSync(rebuilt, dotGit);
  clearNestedGit(sessionClone, root, worktrees);
  writeFileSync(join(root, "done"), "");
}
