import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { dirtyTree } from "./git.js";

let root: string;
let clone: string;

function git(args: string[], cwd: string): void {
  execaSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], dir);
  git(["commit", "-qm", "seed"], dir);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-git-")));
  clone = join(root, "clone");
  initRepo(clone);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("dirtyTree", () => {
  it("returns {kind:'clean'} for a pristine tree", async () => {
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "clean" });
  });

  it("counts modified tracked files", async () => {
    writeFileSync(join(clone, "seed.txt"), "edited\n");
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "dirty", modified: 1, untracked: 0 });
  });

  it("counts new untracked files (not ignored)", async () => {
    writeFileSync(join(clone, "new.txt"), "x\n");
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "dirty", modified: 0, untracked: 1 });
  });

  it("counts staged hunks as modified (not untracked)", async () => {
    writeFileSync(join(clone, "staged.txt"), "y\n");
    git(["add", "staged.txt"], clone);
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "dirty", modified: 1, untracked: 0 });
  });

  it("ignores files matched by .gitignore (clean)", async () => {
    writeFileSync(join(clone, ".gitignore"), "junk/\n");
    git(["add", ".gitignore"], clone);
    git(["commit", "-qm", "ignore"], clone);
    mkdirSync(join(clone, "junk"));
    writeFileSync(join(clone, "junk", "a.log"), "log\n");
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "clean" });
  });

  it("ignores uncommitted .claude/ tree (overlay path)", async () => {
    mkdirSync(join(clone, ".claude", "skills"), { recursive: true });
    writeFileSync(join(clone, ".claude", "settings.local.json"), "{}\n");
    writeFileSync(join(clone, ".claude", "skills", "foo.md"), "skill\n");
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "clean" });
  });

  it("ignores uncommitted .mcp.json (overlay path)", async () => {
    writeFileSync(join(clone, ".mcp.json"), '{"mcpServers":{}}\n');
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "clean" });
  });

  it("ignores uncommitted CLAUDE.md (overlay path)", async () => {
    writeFileSync(join(clone, "CLAUDE.md"), "project memory\n");
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "clean" });
  });

  it("ignores modifications to committed overlay paths", async () => {
    writeFileSync(join(clone, "CLAUDE.md"), "original\n");
    git(["add", "CLAUDE.md"], clone);
    git(["commit", "-qm", "add claude.md"], clone);
    writeFileSync(join(clone, "CLAUDE.md"), "edited\n");
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "clean" });
  });

  it("still flags non-overlay dirty paths even when overlay paths are dirty", async () => {
    mkdirSync(join(clone, ".claude"));
    writeFileSync(join(clone, ".claude", "x.md"), "skill\n");
    writeFileSync(join(clone, "real.txt"), "work\n");
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "dirty", modified: 0, untracked: 1 });
  });

  it("does not exclude nested CLAUDE.md (only top-level)", async () => {
    mkdirSync(join(clone, "sub"));
    writeFileSync(join(clone, "sub", "CLAUDE.md"), "nested\n");
    const r = await dirtyTree(clone);
    expect(r).toEqual({ kind: "dirty", modified: 0, untracked: 1 });
  });

  it("returns scan-failed when .git is removed", async () => {
    rmSync(join(clone, ".git"), { recursive: true, force: true });
    const r = await dirtyTree(clone);
    expect(r.kind).toBe("scan-failed");
    if (r.kind === "scan-failed") {
      expect(r.error.length).toBeGreaterThan(0);
    }
  });
});
