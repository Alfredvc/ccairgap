import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { handoff, scanDirtyRepos } from "./handoff.js";
import { writeManifest } from "./manifest.js";
import { prepareLinkedWorktrees } from "./worktrees.js";

const id = "test-a1b2";
const branch = `ccairgap/${id}`;
const altName = "hostrepo-00000000";

let root: string;
let hostRepo: string;
let sessionDir: string;
let clone: string;

function git(cwd: string, ...args: string[]): string {
  return execaSync("git", args, { cwd, stdio: "pipe" }).stdout;
}

function commit(cwd: string, file: string): void {
  writeFileSync(join(cwd, file), "x\n");
  git(cwd, "add", file);
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", file);
}

function hostBranches(): string[] {
  return git(hostRepo, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n");
}

/**
 * Add a worktree, then rewrite its pointers to the paths a container records:
 * the session clone is mounted at the host repo's path.
 */
function addContainerWorktree(name: string, wtBranch: string, edit?: (wt: string) => void): string {
  const wt = join(clone, ".claude", "worktrees", name);
  mkdirSync(join(clone, ".claude", "worktrees"), { recursive: true });
  git(clone, "worktree", "add", "-q", "-b", wtBranch, wt);
  edit?.(wt);
  const admin = join(clone, ".git", "worktrees", name);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(hostRepo, ".git", "worktrees", name)}\n`);
  writeFileSync(join(admin, "gitdir"), `${join(hostRepo, ".claude", "worktrees", name, ".git")}\n`);
  return wt;
}

function logs(): { logger: (m: string) => void; text: () => string } {
  const lines: string[] = [];
  return { logger: (m) => lines.push(m), text: () => lines.join("\n") };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-worktrees-")));
  hostRepo = join(root, "hostrepo");
  mkdirSync(hostRepo, { recursive: true });
  git(hostRepo, "init", "-q", "-b", "main");
  commit(hostRepo, "seed.txt");

  sessionDir = join(root, "sessions", id);
  mkdirSync(join(sessionDir, "repos"), { recursive: true });
  clone = join(sessionDir, "repos", altName);
  execaSync("git", ["clone", "--shared", "-q", hostRepo, clone], { stdio: "pipe" });
  git(clone, "checkout", "-q", "-b", branch);
  writeManifest(sessionDir, {
    version: 1,
    cli_version: "test",
    image_tag: "test:1",
    created_at: new Date().toISOString(),
    repos: [{ basename: "hostrepo", host_path: hostRepo, alternates_name: altName }],
    branch,
    claude_code: {},
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("handoff — linked worktrees", () => {
  it("preserves a session whose worktree has only uncommitted files", async () => {
    const wt = addContainerWorktree("x", "wt1", (w) => writeFileSync(join(w, "u.txt"), "u\n"));
    const log = logs();

    const r = await handoff(sessionDir, "test", log.logger);

    expect(r.preserved).toBe(true);
    expect(readFileSync(join(wt, "u.txt"), "utf8")).toBe("u\n");
    expect(log.text()).toContain("uncommitted changes in linked worktree");
    expect(log.text()).toContain(`Your uncommitted work is at:\n[handoff]   ${wt}`);
  });

  it("delivers a worktree commit and removes the session when the sandbox branch is empty", async () => {
    addContainerWorktree("x", "wt1", (w) => commit(w, "c.txt"));
    const log = logs();

    const r = await handoff(sessionDir, "test", log.logger);

    expect(r.removed).toBe(true);
    expect(hostBranches()).toContain(`${branch}-worktrees/wt1`);
    expect(hostBranches()).not.toContain(branch);
    expect(git(hostRepo, "show", `${branch}-worktrees/wt1:c.txt`)).toBe("x");
    expect(log.text()).toContain(`is on the host as ${branch}-worktrees/wt1`);
  });

  it("delivers a worktree commit when the sandbox branch also has commits", async () => {
    commit(clone, "sandbox.txt");
    addContainerWorktree("x", "wt1", (w) => commit(w, "c.txt"));

    const r = await handoff(sessionDir, "test", () => {});

    expect(r.removed).toBe(true);
    expect(hostBranches()).toEqual(expect.arrayContaining([branch, `${branch}-worktrees/wt1`]));
    expect(r.fetched.map((f) => f.status)).toEqual(["fetched", "fetched"]);
  });

  it("creates no ref for a clean worktree with no new commits", async () => {
    commit(clone, "sandbox.txt");
    addContainerWorktree("x", "wt1");

    const r = await handoff(sessionDir, "test", () => {});

    expect(r.removed).toBe(true);
    expect(hostBranches()).not.toContain(`${branch}-worktrees/wt1`);
  });

  it("delivers the commit and preserves the session when the worktree is also dirty", async () => {
    addContainerWorktree("x", "wt1", (w) => {
      commit(w, "c.txt");
      writeFileSync(join(w, "u.txt"), "u\n");
    });

    const r = await handoff(sessionDir, "test", () => {});

    expect(r.preserved).toBe(true);
    expect(hostBranches()).toContain(`${branch}-worktrees/wt1`);
  });

  it("lets --no-preserve-dirty discard a dirty worktree", async () => {
    addContainerWorktree("x", "wt1", (w) => writeFileSync(join(w, "u.txt"), "u\n"));

    const r = await handoff(sessionDir, "test", () => {}, { noPreserveDirty: true });

    expect(r.removed).toBe(true);
  });

  it("delivers work that the user commits on the host before a second handoff", async () => {
    const wt = addContainerWorktree("x", "wt1", (w) => writeFileSync(join(w, "u.txt"), "u\n"));
    await handoff(sessionDir, "test", () => {});
    expect(hostBranches()).not.toContain(`${branch}-worktrees/wt1`);

    git(wt, "add", "u.txt");
    git(wt, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "u");
    const r = await handoff(sessionDir, "test", () => {});

    expect(r.removed).toBe(true);
    expect(git(hostRepo, "show", `${branch}-worktrees/wt1:u.txt`)).toBe("u");
  });

  it("leaves the real repo's admin dir with the same name alone", async () => {
    commit(hostRepo, "host.txt");
    const hostWt = join(root, "host-wt");
    git(hostRepo, "worktree", "add", "-q", "-b", "host-x", hostWt);
    // git names the admin dir after the path's basename.
    const hostAdmin = join(hostRepo, ".git", "worktrees", "host-wt");
    const before = readFileSync(join(hostAdmin, "gitdir"), "utf8");
    const wt = addContainerWorktree("host-wt", "wt1", (w) => writeFileSync(join(w, "u.txt"), "u\n"));

    await handoff(sessionDir, "test", () => {});

    expect(readFileSync(join(hostAdmin, "gitdir"), "utf8")).toBe(before);
    expect(readFileSync(join(wt, ".git"), "utf8")).toBe(
      `gitdir: ${join(clone, ".git", "worktrees", "host-wt")}\n`,
    );
    expect(git(hostWt, "status", "--short")).toBe("");
  });

  it("warns about a worktree outside the clone and still delivers its branch", async () => {
    const outside = join(root, "gone");
    git(clone, "worktree", "add", "-q", "-b", "wt1", outside);
    commit(outside, "c.txt");
    rmSync(outside, { recursive: true, force: true });
    const log = logs();

    const r = await handoff(sessionDir, "test", log.logger);

    expect(r.removed).toBe(true);
    expect(hostBranches()).toContain(`${branch}-worktrees/wt1`);
    expect(log.text()).toContain(`linked worktree ${outside} was outside the session clone`);
  });

  it("preserves the session when a worktree branch cannot be fetched", async () => {
    addContainerWorktree("x", "wt1", (w) => commit(w, "c.txt"));
    // A branch named like the namespace dir makes the host ref update fail.
    git(hostRepo, "branch", `${branch}-worktrees`);
    const log = logs();

    const r = await handoff(sessionDir, "test", log.logger);

    expect(r.preserved).toBe(true);
    expect(log.text()).toContain("fetch failed");
    expect(log.text()).toContain("Your committed work is at:");
    expect(log.text()).toContain(`fetch ${clone} wt1:wt1`);
  });
});

describe("handoff — agent-controlled worktree data", () => {
  it("does not write through a symlinked worktree .git file", async () => {
    const wt = addContainerWorktree("x", "wt1");
    const victim = join(root, "victim");
    writeFileSync(victim, "safe\n");
    rmSync(join(wt, ".git"));
    symlinkSync(victim, join(wt, ".git"));
    const log = logs();

    const r = await handoff(sessionDir, "test", log.logger);

    expect(readFileSync(victim, "utf8")).toBe("safe\n");
    expect(r.preserved).toBe(true);
    expect(log.text()).toContain("not a regular file");
  });

  it("does not write through a symlinked admin gitdir file", async () => {
    const wt = addContainerWorktree("x", "wt1");
    const victim = join(root, "victim");
    writeFileSync(victim, `${join(hostRepo, ".claude", "worktrees", "x", ".git")}\n`);
    const gitdirFile = join(clone, ".git", "worktrees", "x", "gitdir");
    rmSync(gitdirFile);
    symlinkSync(victim, gitdirFile);

    const r = await handoff(sessionDir, "test", () => {});

    expect(readFileSync(victim, "utf8")).toContain("hostrepo");
    expect(r.preserved).toBe(true);
    expect(existsSync(wt)).toBe(true);
  });

  it("rejects a worktree path that leaves the clone through a symlink", async () => {
    addContainerWorktree("x", "wt1");
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, ".git"), "keep\n");
    const wt = join(clone, ".claude", "worktrees", "x");
    rmSync(wt, { recursive: true, force: true });
    symlinkSync(outside, wt);

    const r = await handoff(sessionDir, "test", () => {});

    expect(readFileSync(join(outside, ".git"), "utf8")).toBe("keep\n");
    expect(r.preserved).toBe(true);
  });

  it("refuses a branch name that would change the refspec", async () => {
    addContainerWorktree("x", "wt1", (w) => commit(w, "c.txt"));
    const mainBefore = git(hostRepo, "rev-parse", "main");
    writeFileSync(
      join(clone, ".git", "worktrees", "x", "HEAD"),
      "ref: refs/heads/wt1:refs/heads/main\n",
    );
    const log = logs();

    const r = await handoff(sessionDir, "test", log.logger);

    expect(r.preserved).toBe(true);
    expect(log.text()).toContain("invalid worktree branch name");
    expect(git(hostRepo, "rev-parse", "main")).toBe(mainBefore);
  });
});

describe("handoff — other side branches", () => {
  it("names committed work correctly and prints the fetch command", async () => {
    git(clone, "checkout", "-q", "-b", "side");
    commit(clone, "side.txt");
    git(clone, "checkout", "-q", branch);
    const log = logs();

    const r = await handoff(sessionDir, "test", log.logger);

    expect(r.preserved).toBe(true);
    expect(log.text()).toContain("Your committed work is at:");
    expect(log.text()).not.toContain("uncommitted");
    expect(log.text()).toContain(`git -C ${hostRepo} fetch ${clone} side:side`);
    expect(hostBranches()).not.toContain(`${branch}-worktrees/side`);
  });
});

describe("scanDirtyRepos — linked worktrees", () => {
  it("reports a dirty worktree with its host path", async () => {
    const wt = addContainerWorktree("x", "wt1", (w) => writeFileSync(join(w, "u.txt"), "u\n"));

    const dirty = await scanDirtyRepos(sessionDir, "test");

    expect(dirty).toEqual([{ hostPath: hostRepo, sessionClone: wt, modified: 0, untracked: 1 }]);
  });
});

describe("prepareLinkedWorktrees", () => {
  it("returns nothing for a clone with no linked worktrees", () => {
    expect(prepareLinkedWorktrees(clone, hostRepo)).toEqual([]);
  });

  it("is idempotent", () => {
    const wt = addContainerWorktree("x", "wt1");
    const first = prepareLinkedWorktrees(clone, hostRepo);
    const second = prepareLinkedWorktrees(clone, hostRepo);

    expect(first[0]!.path).toBe(wt);
    expect(first[0]!.branch).toBe("wt1");
    expect(second[0]!.path).toBe(wt);
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("wt1");
  });

  it("reports a detached worktree with no branch", () => {
    const wt = addContainerWorktree("x", "wt1");
    git(clone, "worktree", "list");
    writeFileSync(
      join(clone, ".git", "worktrees", "x", "HEAD"),
      `${git(clone, "rev-parse", "HEAD")}\n`,
    );

    expect(prepareLinkedWorktrees(clone, hostRepo)).toEqual([
      { recordedPath: join(hostRepo, ".claude", "worktrees", "x"), path: wt, branch: null },
    ]);
  });
});
