import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { handoff, scanDirtyRepos } from "./handoff.js";
import { writeManifest } from "./manifest.js";
import { isSessionCloneSanitized, MOVED_GIT_NOTE, sanitizeSessionClone } from "./sessionCloneTrust.js";

const id = "test-a1b2";
const branch = `ccairgap/${id}`;
const name = "hostrepo-00000000";

let root: string;
let hostRepo: string;
let sessionDir: string;
let clone: string;
let marker: string;
let command: string;

function git(cwd: string, ...args: string[]): string {
  return execaSync(
    "git",
    ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "protocol.file.allow=always", ...args],
    { cwd, stdio: "pipe" },
  ).stdout;
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), "x\n");
  git(cwd, "add", file);
  git(cwd, "commit", "-qm", file);
}

function hook(path: string): void {
  writeFileSync(path, `#!/bin/sh\ntouch ${marker}\n`);
  chmodSync(path, 0o755);
}

function hostRefs(): string[] {
  return git(hostRepo, "for-each-ref", "--format=%(refname:short)").split("\n");
}

/** A copy of the clone's `.git` that carries a hostile config, outside the clone. */
function hostileGitDir(): string {
  const dir = join(root, "hostile-git");
  cpSync(join(clone, ".git"), dir, { recursive: true });
  git(root, `--git-dir=${dir}`, "config", "core.fsmonitor", command);
  return dir;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-trust-")));
  marker = join(root, "MARKER");
  command = `touch ${marker}; true`;
  hostRepo = join(root, "hostrepo");
  mkdirSync(hostRepo);
  git(hostRepo, "init", "-q", "-b", "main");
  commit(hostRepo, "seed.txt");

  sessionDir = join(root, "sessions", id);
  mkdirSync(join(sessionDir, "repos"), { recursive: true });
  clone = join(sessionDir, "repos", name);
  execaSync("git", ["clone", "--shared", "-q", hostRepo, clone], { stdio: "pipe" });
  git(clone, "checkout", "-q", "-b", branch);
  writeManifest(sessionDir, {
    version: 1,
    cli_version: "test",
    image_tag: "test:1",
    created_at: new Date().toISOString(),
    repos: [{ basename: "hostrepo", host_path: hostRepo, alternates_name: name }],
    branch,
    claude_code: {},
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const run = () => handoff(sessionDir, "test", () => {});

describe("handoff runs no container-controlled command on the host", () => {
  // Each plant makes the clone dirty or committed, so handoff reaches every git call.
  const routes: Array<[string, () => void]> = [
    ["core.fsmonitor", () => git(clone, "config", "core.fsmonitor", command)],
    ["hooks/post-index-change", () => hook(join(clone, ".git", "hooks", "post-index-change"))],
    [
      "core.hooksPath",
      () => {
        mkdirSync(join(root, "hooks"));
        hook(join(root, "hooks", "post-index-change"));
        git(clone, "config", "core.hooksPath", join(root, "hooks"));
      },
    ],
    [
      "filter driver",
      () => {
        git(clone, "config", "filter.x.clean", command);
        writeFileSync(join(clone, ".git", "info", "attributes"), "seed.txt filter=x\n");
      },
    ],
    [
      "include.path",
      () => {
        writeFileSync(join(root, "inc"), `[core]\n\tfsmonitor = ${JSON.stringify(command)}\n`);
        git(clone, "config", "include.path", join(root, "inc"));
      },
    ],
    [
      "promisor remote",
      () => {
        git(clone, "config", "extensions.partialClone", "ev");
        git(clone, "config", "remote.ev.promisor", "true");
        git(clone, "config", "remote.ev.url", `ext::sh -c touch% ${marker}`);
      },
    ],
    ["core.sshCommand", () => git(clone, "config", "core.sshCommand", command)],
    ["upload-pack hook", () => hook(join(clone, ".git", "hooks", "post-upload-pack"))],
    ["uploadpack.packObjectsHook", () => git(clone, "config", "uploadpack.packObjectsHook", command)],
  ];

  it.each(routes)("%s, committed work", async (_label, plant) => {
    commit(clone, "work.txt");
    plant();

    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.removed).toBe(true);
    expect(hostRefs()).toContain(branch);
  });

  it.each(routes)("%s, uncommitted work", async (_label, plant) => {
    writeFileSync(join(clone, "seed.txt"), "edited\n");
    plant();

    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.preserved).toBe(true);
    expect(readFileSync(join(clone, "seed.txt"), "utf8")).toBe("edited\n");
  });

  it("`.git` as a symlink: runs nothing, runs no git, preserves", async () => {
    const hostile = hostileGitDir();
    rmSync(join(clone, ".git"), { recursive: true });
    symlinkSync(hostile, join(clone, ".git"));

    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.preserved).toBe(true);
    expect(isSessionCloneSanitized(sessionDir, name)).toBe(false);
  });

  it("`.git` as a gitfile: runs nothing, runs no git, preserves", async () => {
    const hostile = hostileGitDir();
    rmSync(join(clone, ".git"), { recursive: true });
    writeFileSync(join(clone, ".git"), `gitdir: ${hostile}\n`);

    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.preserved).toBe(true);
  });

  it("`.git/commondir`: runs nothing, runs no git, preserves", async () => {
    writeFileSync(join(clone, ".git", "commondir"), `${hostileGitDir()}\n`);

    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.preserved).toBe(true);
  });

  it("worktree admin commondir: the rebuild drops it", async () => {
    const wt = join(clone, ".claude", "worktrees", "x");
    git(clone, "worktree", "add", "-q", "-b", "wt1", wt);
    const hostile = hostileGitDir();
    writeFileSync(join(clone, ".git", "worktrees", "x", "commondir"), `${hostile}\n`);
    writeFileSync(join(wt, "u.txt"), "u\n");

    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.preserved).toBe(true);
    expect(readFileSync(join(clone, ".git", "worktrees", "x", "commondir"), "utf8")).toBe("../..\n");
  });

  it("a real `.git` directory at a worktree: runs nothing, preserves", async () => {
    const wt = join(clone, ".claude", "worktrees", "x");
    git(clone, "worktree", "add", "-q", "-b", "wt1", wt);
    rmSync(join(wt, ".git"));
    cpSync(hostileGitDir(), join(wt, ".git"), { recursive: true });

    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.preserved).toBe(true);
  });

  it("submodule config: runs nothing, and a populated submodule preserves", async () => {
    const subSrc = join(root, "subsrc");
    mkdirSync(subSrc);
    git(subSrc, "init", "-q", "-b", "main");
    commit(subSrc, "s.txt");
    git(clone, "submodule", "--quiet", "add", subSrc, "sub");
    git(clone, "commit", "-qm", "sub");
    git(join(clone, "sub"), "config", "core.fsmonitor", command);
    // A real repo at the gitlink path, because the rebuild drops `.git/modules`.
    rmSync(join(clone, "sub", ".git"));
    cpSync(hostileGitDir(), join(clone, "sub", ".git"), { recursive: true });
    writeFileSync(join(clone, "sub", "lost.txt"), "work\n");

    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.preserved).toBe(true);
    expect(readFileSync(join(clone, "sub", "lost.txt"), "utf8")).toBe("work\n");
  });

  it("an untracked nested repo runs nothing", async () => {
    const nested = join(clone, "nested");
    mkdirSync(nested);
    git(nested, "init", "-q", "-b", "main");
    git(nested, "config", "core.fsmonitor", command);

    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.preserved).toBe(true);
  });

  it("the printed rescue commands run no container hook", async () => {
    hook(join(clone, ".git", "hooks", "pre-commit"));
    git(clone, "config", "core.fsmonitor", command);
    writeFileSync(join(clone, "u.txt"), "u\n");
    await run();

    git(clone, "status");
    git(clone, "add", "-A");
    git(clone, "commit", "-qm", "rescued");
    const r = await run();

    expect(existsSync(marker)).toBe(false);
    expect(r.removed).toBe(true);
    expect(git(hostRepo, "show", `${branch}:u.txt`)).toBe("u");
  });

  const nested: Array<[string, () => void]> = [
    [
      "a repo at a gitlink path",
      () => {
        const subSrc = join(root, "subsrc");
        mkdirSync(subSrc);
        git(subSrc, "init", "-q", "-b", "main");
        commit(subSrc, "s.txt");
        git(clone, "submodule", "--quiet", "add", subSrc, "sub");
        git(clone, "commit", "-qm", "sub");
        git(join(clone, "sub"), "config", "core.fsmonitor", command);
        writeFileSync(join(clone, "sub", "s.txt"), "edited\n");
      },
    ],
    [
      "an untracked nested repo",
      () => {
        const n = join(clone, "nested");
        mkdirSync(n);
        git(n, "init", "-q", "-b", "main");
        commit(n, "q.txt");
        git(n, "config", "core.fsmonitor", command);
        writeFileSync(join(n, "q.txt"), "edited\n");
      },
    ],
    [
      "a nested repo under an ignored path",
      () => {
        writeFileSync(join(clone, ".git", "info", "exclude"), "ignored/\n");
        const n = join(clone, "ignored", "deep");
        mkdirSync(n, { recursive: true });
        git(n, "init", "-q", "-b", "main");
        git(n, "config", "core.fsmonitor", command);
        writeFileSync(join(clone, "u.txt"), "u\n");
      },
    ],
    [
      "a `.git` symlink to a hostile dir",
      () => {
        mkdirSync(join(clone, "link"));
        writeFileSync(join(clone, "link", "f.txt"), "f\n");
        symlinkSync(hostileGitDir(), join(clone, "link", ".git"));
      },
    ],
  ];

  it.each(nested)("printed rescue commands and %s run nothing", async (_label, plant) => {
    plant();
    const r = await run();

    expect(r.preserved).toBe(true);
    git(clone, "status");
    git(clone, "add", "-A");
    git(clone, "status");
    git(clone, "diff", "HEAD");
    git(clone, "commit", "-qm", "rescued", "--allow-empty");
    git(clone, "status");
    await run();

    expect(existsSync(marker)).toBe(false);
  });

  it("scanDirtyRepos runs nothing", async () => {
    git(clone, "config", "core.fsmonitor", command);
    writeFileSync(join(clone, "u.txt"), "u\n");

    const dirty = await scanDirtyRepos(sessionDir, "test");

    expect(existsSync(marker)).toBe(false);
    expect(dirty).toHaveLength(1);
  });
});

describe("handoff writes nothing through container-made symlinks", () => {
  it("objects/info/alternates", async () => {
    const victim = join(root, "victim");
    writeFileSync(victim, "safe\n");
    commit(clone, "work.txt");
    const alternates = join(clone, ".git", "objects", "info", "alternates");
    rmSync(alternates);
    symlinkSync(victim, alternates);

    await run();

    expect(readFileSync(victim, "utf8")).toBe("safe\n");
  });

  it("objects/info", async () => {
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(join(clone, ".git", "objects", "info"), { recursive: true });
    symlinkSync(elsewhere, join(clone, ".git", "objects", "info"));

    const r = await run();

    expect(existsSync(join(elsewhere, "alternates"))).toBe(false);
    expect(r.preserved).toBe(true);
  });
});

describe("handoff keeps agent-made tags out of the real repo", () => {
  it("delivers the branch without its tags", async () => {
    commit(clone, "work.txt");
    git(clone, "tag", "evil");

    await run();

    expect(hostRefs()).toContain(branch);
    expect(hostRefs()).not.toContain("evil");
  });
});

describe("sanitizeSessionClone", () => {
  const sanitize = () => sanitizeSessionClone({ sessionDir, name, sessionClone: clone, hostPath: hostRepo });

  it("drops config and hooks, and keeps refs, HEAD and working tree state", async () => {
    commit(clone, "work.txt");
    git(clone, "branch", "side");
    git(clone, "config", "core.fsmonitor", command);
    hook(join(clone, ".git", "hooks", "pre-commit"));
    writeFileSync(join(clone, "seed.txt"), "edited\n");
    writeFileSync(join(clone, "new.txt"), "new\n");

    await sanitize();

    expect(existsSync(join(clone, ".git", "hooks"))).toBe(false);
    expect(readFileSync(join(clone, ".git", "config"), "utf8")).not.toContain("fsmonitor");
    expect(git(clone, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(git(clone, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n")).toEqual(
      expect.arrayContaining(["main", "side", branch]),
    );
    expect(git(clone, "status", "--porcelain").split("\n").sort()).toEqual([" M seed.txt", "?? new.txt"]);
    expect(git(clone, "rev-list", "--count", branch, "--not", "--remotes=origin")).toBe("1");
    expect(existsSync(marker)).toBe(false);
  });

  it("is idempotent and leaves work added after the first run", async () => {
    await sanitize();
    commit(clone, "after.txt");

    await sanitize();

    expect(git(clone, "log", "-1", "--format=%s")).toBe("after.txt");
  });

  it("resumes after a crash between its two moves", async () => {
    commit(clone, "work.txt");
    const state = join(sessionDir, "sanitized-git", name);
    mkdirSync(state, { recursive: true });
    renameSync(join(clone, ".git"), join(state, "untrusted-git"));

    await sanitize();

    expect(git(clone, "log", "-1", "--format=%s")).toBe("work.txt");
    expect(isSessionCloneSanitized(sessionDir, name)).toBe(true);
  });

  it("moves a nested `.git`, and leaves a note that names its new path", async () => {
    const n = join(clone, "nested");
    mkdirSync(n);
    git(n, "init", "-q", "-b", "main");
    commit(n, "q.txt");

    await sanitize();

    expect(existsSync(join(n, ".git"))).toBe(false);
    const note = readFileSync(join(n, MOVED_GIT_NOTE), "utf8");
    const target = note.match(/moved the git data of this directory to (.+)\.\n/)![1]!;
    expect(existsSync(join(target, "HEAD"))).toBe(true);
    expect(git(clone, "status", "--porcelain")).toBe("?? nested/");
  });

  it("keeps a directory that held only a nested `.git` visible to the dirty scan", async () => {
    const n = join(clone, "nested");
    mkdirSync(n);
    git(n, "init", "-q", "-b", "main");
    commit(n, "q.txt");
    rmSync(join(n, "q.txt"));

    const r = await run();

    expect(r.preserved).toBe(true);
  });

  it("does not follow a symlink during the walk", async () => {
    const outside = join(root, "outside");
    mkdirSync(join(outside, "repo"), { recursive: true });
    git(join(outside, "repo"), "init", "-q", "-b", "main");
    symlinkSync(outside, join(clone, "link"));

    await sanitize();

    expect(existsSync(join(outside, "repo", ".git", "HEAD"))).toBe(true);
    expect(existsSync(join(outside, "repo", MOVED_GIT_NOTE))).toBe(false);
  });

  it("fails closed when a directory cannot be read", async () => {
    const hidden = join(clone, "hidden");
    mkdirSync(hidden);
    chmodSync(hidden, 0);
    try {
      await expect(sanitize()).rejects.toThrow();
      expect(isSessionCloneSanitized(sessionDir, name)).toBe(false);
    } finally {
      chmodSync(hidden, 0o755);
    }
    await sanitize();
    expect(isSessionCloneSanitized(sessionDir, name)).toBe(true);
  });

  it("keeps a linked worktree's `.git` and replaces its target", async () => {
    const wt = join(clone, ".claude", "worktrees", "x");
    git(clone, "worktree", "add", "-q", "-b", "wt1", wt);
    writeFileSync(join(wt, ".git"), `gitdir: ${hostileGitDir()}\n`);

    await sanitize();

    expect(readFileSync(join(wt, ".git"), "utf8")).toBe(
      `gitdir: ${join(clone, ".git", "worktrees", "x")}\n`,
    );
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("wt1");
    expect(existsSync(marker)).toBe(false);
  });

  it("handles a detached HEAD", async () => {
    commit(clone, "work.txt");
    const sha = git(clone, "rev-parse", "HEAD");
    git(clone, "checkout", "-q", "--detach");

    await sanitize();

    expect(git(clone, "rev-parse", "HEAD")).toBe(sha);
    expect(git(clone, "status", "--porcelain")).toBe("");
  });

  it("handles a host repo with sha256 objects", async () => {
    const sha256Host = join(root, "sha256host");
    mkdirSync(sha256Host);
    git(sha256Host, "init", "-q", "-b", "main", "--object-format=sha256");
    commit(sha256Host, "seed.txt");
    const c = join(sessionDir, "repos", "sha256");
    execaSync("git", ["clone", "--shared", "-q", sha256Host, c], { stdio: "pipe" });
    commit(c, "work.txt");

    await sanitizeSessionClone({ sessionDir, name: "sha256", sessionClone: c, hostPath: sha256Host });

    expect(git(c, "rev-parse", "--show-object-format")).toBe("sha256");
    expect(git(c, "log", "-1", "--format=%s")).toBe("work.txt");
  });

  it("handles a shallow host repo", async () => {
    const full = join(root, "full");
    mkdirSync(full);
    git(full, "init", "-q", "-b", "main");
    commit(full, "a.txt");
    commit(full, "b.txt");
    const shallow = join(root, "shallow");
    execaSync("git", ["clone", "-q", "--depth=1", `file://${full}`, shallow], { stdio: "pipe" });
    const c = join(sessionDir, "repos", "shallow");
    execaSync("git", ["clone", "--shared", "-q", shallow, c], { stdio: "pipe" });
    commit(c, "work.txt");

    await sanitizeSessionClone({ sessionDir, name: "shallow", sessionClone: c, hostPath: shallow });

    expect(git(c, "log", "-1", "--format=%s")).toBe("work.txt");
    expect(git(c, "status", "--porcelain")).toBe("");
  });
});
