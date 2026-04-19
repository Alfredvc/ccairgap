import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import {
  findCanonicalRepoRoot,
  resolveAutoMemoryHostDir,
  sanitizePath,
} from "./autoMemory.js";

let root: string;
let hostHome: string;
let hostClaude: string;
let workspace: string;
let managed: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-auto-memory-")));
  hostHome = join(root, "home", "alice");
  hostClaude = join(hostHome, ".claude");
  workspace = join(root, "src", "myrepo");
  managed = join(root, "Library", "Application Support", "ClaudeCode");
  mkdirSync(hostClaude, { recursive: true });
  mkdirSync(workspace, { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sanitizePath", () => {
  it("mirrors Claude Code: replaces every non-alphanumeric char with -", () => {
    expect(sanitizePath("/Users/alice/src/my-project")).toBe("-Users-alice-src-my-project");
    expect(sanitizePath("/Users/alice/src/my.project")).toBe("-Users-alice-src-my-project");
    expect(sanitizePath("/Users/alice/src/my_project")).toBe("-Users-alice-src-my-project");
  });

  it("truncates + appends djb2-derived hash for paths > 200 chars", () => {
    const long = "/a".repeat(120); // 240 chars, > 200
    const out = sanitizePath(long);
    expect(out.length).toBeGreaterThan(200);
    // Stable deterministic suffix — call twice, same result
    expect(sanitizePath(long)).toBe(out);
    // Different input → different output
    const other = "/b".repeat(120);
    expect(sanitizePath(other)).not.toBe(out);
  });
});

describe("resolveAutoMemoryHostDir", () => {
  it("falls back to the default <hostClaude>/projects/<sanitize>/memory/ when no override is set", () => {
    const def = join(hostClaude, "projects", sanitizePath(workspace), "memory");
    mkdirSync(def, { recursive: true });
    writeFileSync(join(def, "MEMORY.md"), "# seed\n");

    const got = resolveAutoMemoryHostDir({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      managedPolicyDir: undefined,
      homeDir: hostHome,
      env: {},
    });
    expect(got).toBe(def);
  });

  it("returns undefined when the default path does not exist", () => {
    const got = resolveAutoMemoryHostDir({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      managedPolicyDir: undefined,
      homeDir: hostHome,
      env: {},
    });
    expect(got).toBeUndefined();
  });

  it("honors autoMemoryDirectory from user settings.json (tilde expanded)", () => {
    const override = join(hostHome, "my-memory");
    mkdirSync(override, { recursive: true });
    writeFileSync(
      join(hostClaude, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: "~/my-memory" }),
    );
    const got = resolveAutoMemoryHostDir({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      managedPolicyDir: undefined,
      homeDir: hostHome,
      env: {},
    });
    expect(got).toBe(override);
  });

  it("honors autoMemoryDirectory from workspace settings.local.json (higher than user)", () => {
    const local = join(root, "local-mem");
    const user = join(root, "user-mem");
    mkdirSync(local, { recursive: true });
    mkdirSync(user, { recursive: true });

    mkdirSync(join(workspace, ".claude"), { recursive: true });
    writeFileSync(
      join(workspace, ".claude", "settings.local.json"),
      JSON.stringify({ autoMemoryDirectory: local }),
    );
    writeFileSync(
      join(hostClaude, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: user }),
    );
    const got = resolveAutoMemoryHostDir({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      managedPolicyDir: undefined,
      homeDir: hostHome,
      env: {},
    });
    expect(got).toBe(local);
  });

  it("honors autoMemoryDirectory from managed-settings.json (highest)", () => {
    const mgmt = join(root, "managed-mem");
    const user = join(root, "user-mem");
    mkdirSync(mgmt, { recursive: true });
    mkdirSync(user, { recursive: true });
    mkdirSync(managed, { recursive: true });
    writeFileSync(
      join(managed, "managed-settings.json"),
      JSON.stringify({ autoMemoryDirectory: mgmt }),
    );
    writeFileSync(
      join(hostClaude, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: user }),
    );
    const got = resolveAutoMemoryHostDir({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      managedPolicyDir: managed,
      homeDir: hostHome,
      env: {},
    });
    expect(got).toBe(mgmt);
  });

  it("honors CLAUDE_COWORK_MEMORY_PATH_OVERRIDE env var (absolute path, no expansion)", () => {
    const cowork = join(root, "cowork-mem");
    mkdirSync(cowork, { recursive: true });
    const got = resolveAutoMemoryHostDir({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      managedPolicyDir: undefined,
      homeDir: hostHome,
      env: { CLAUDE_COWORK_MEMORY_PATH_OVERRIDE: cowork },
    });
    expect(got).toBe(cowork);
  });

  it("rejects relative and suspicious override paths", () => {
    mkdirSync(join(root, "relative"), { recursive: true });
    writeFileSync(
      join(hostClaude, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: "relative" }),
    );
    const got = resolveAutoMemoryHostDir({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      managedPolicyDir: undefined,
      homeDir: hostHome,
      env: {},
    });
    // Relative path is rejected → fall back to default (which doesn't exist here) → undefined
    expect(got).toBeUndefined();
  });

  it("returns undefined when resolved path does not exist", () => {
    writeFileSync(
      join(hostClaude, "settings.json"),
      JSON.stringify({ autoMemoryDirectory: "/does/not/exist" }),
    );
    const got = resolveAutoMemoryHostDir({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      managedPolicyDir: undefined,
      homeDir: hostHome,
      env: {},
    });
    expect(got).toBeUndefined();
  });
});

describe("findCanonicalRepoRoot", () => {
  let repo: string;
  let worktree: string;

  beforeEach(() => {
    repo = join(root, "main");
    mkdirSync(repo, { recursive: true });
    execaSync("git", ["init", "-q"], { cwd: repo });
    execaSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-q", "-m", "init"],
      { cwd: repo },
    );
    worktree = join(root, "wt");
    execaSync("git", ["-C", repo, "worktree", "add", "-q", worktree, "-b", "wt-branch"]);
  });

  it("returns the repo itself for a non-worktree", () => {
    expect(findCanonicalRepoRoot(repo)).toBe(realpathSync(repo));
  });

  it("returns the canonical root for a worktree", () => {
    expect(findCanonicalRepoRoot(worktree)).toBe(realpathSync(repo));
  });

  it("returns the input path when git fails", () => {
    const notRepo = join(root, "not-git");
    mkdirSync(notRepo);
    expect(findCanonicalRepoRoot(notRepo)).toBe(notRepo);
  });
});
