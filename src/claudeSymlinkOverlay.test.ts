import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSymlinkOverlay,
  CLAUDE_OVERLAY_ALLOWLIST,
  scanEscapingSymlinks,
} from "./claudeSymlinkOverlay.js";

describe("scanEscapingSymlinks", () => {
  let root: string;
  let claudeDir: string;
  let externalDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccairgap-symlink-test-"));
    claudeDir = join(root, ".claude");
    externalDir = join(root, "ext");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty array when ~/.claude/ has no symlinks", () => {
    writeFileSync(join(claudeDir, "settings.json"), "{}");
    expect(scanEscapingSymlinks(claudeDir)).toEqual([]);
  });

  it("returns empty array when ~/.claude/ does not exist", () => {
    expect(scanEscapingSymlinks(join(root, "nope"))).toEqual([]);
  });

  it("finds absolute symlinks at top level", () => {
    const target = join(externalDir, "skill");
    mkdirSync(target);
    symlinkSync(target, join(claudeDir, "skills"));
    const out = scanEscapingSymlinks(claudeDir);
    expect(out).toHaveLength(1);
    expect(out[0]?.relPath).toBe("skills");
    expect(out[0]?.rawTarget).toBe(target);
  });

  it("finds absolute symlinks nested inside subdirectories", () => {
    mkdirSync(join(claudeDir, "skills"));
    const target = join(externalDir, "ccairgap-configure");
    mkdirSync(target);
    symlinkSync(target, join(claudeDir, "skills", "ccairgap-configure"));
    const out = scanEscapingSymlinks(claudeDir);
    expect(out).toHaveLength(1);
    expect(out[0]?.relPath).toBe("skills/ccairgap-configure");
  });

  it("skips relative symlinks that stay inside ~/.claude/", () => {
    mkdirSync(join(claudeDir, "real"));
    symlinkSync("real", join(claudeDir, "agents"));
    mkdirSync(join(claudeDir, "skills"));
    symlinkSync("../real", join(claudeDir, "skills", "inside"));
    expect(scanEscapingSymlinks(claudeDir)).toEqual([]);
  });

  it("finds relative symlinks whose target leaves ~/.claude/", () => {
    mkdirSync(join(claudeDir, "skills"));
    symlinkSync("../../.agents/skills/stop-slop", join(claudeDir, "skills", "stop-slop"));
    symlinkSync("../outside", join(claudeDir, "CLAUDE.md"));
    // Re-enters ~/.claude/ by its host name. The container mounts the root at
    // /host-claude, so this target does not resolve there either.
    symlinkSync("../.claude/real", join(claudeDir, "settings.json"));
    const out = scanEscapingSymlinks(claudeDir).sort((a, b) => a.relPath.localeCompare(b.relPath));
    expect(out).toEqual([
      { relPath: "CLAUDE.md", rawTarget: "../outside" },
      { relPath: "settings.json", rawTarget: "../.claude/real" },
      { relPath: "skills/stop-slop", rawTarget: "../../.agents/skills/stop-slop" },
    ]);
  });

  it("does not enter application data such as jobs/ (symlinks to whole repos)", () => {
    const repo = join(externalDir, "repo");
    mkdirSync(repo);
    mkdirSync(join(claudeDir, "jobs", "f780ca2f", "tmp", "src"), { recursive: true });
    mkdirSync(join(claudeDir, "tasks"));
    symlinkSync(repo, join(claudeDir, "jobs", "f780ca2f", "tmp", "src", "repo"));
    symlinkSync(repo, join(claudeDir, "tasks", "repo"));
    symlinkSync(repo, join(claudeDir, "unknown-top-level"));
    expect(scanEscapingSymlinks(claudeDir)).toEqual([]);
  });

  it("finds a symlink at every allowlisted top-level name", () => {
    const target = join(externalDir, "tgt");
    mkdirSync(target);
    for (const name of CLAUDE_OVERLAY_ALLOWLIST) {
      symlinkSync(target, join(claudeDir, name));
    }
    const found = scanEscapingSymlinks(claudeDir).map((e) => e.relPath).sort();
    expect(found).toEqual([...CLAUDE_OVERLAY_ALLOWLIST].sort());
  });

  it("keeps a nested dir named like a non-allowlisted top-level entry", () => {
    const target = join(externalDir, "tgt");
    mkdirSync(target);
    mkdirSync(join(claudeDir, "skills", "jobs"), { recursive: true });
    symlinkSync(target, join(claudeDir, "skills", "jobs", "x"));
    expect(scanEscapingSymlinks(claudeDir).map((e) => e.relPath)).toEqual(["skills/jobs/x"]);
  });

  it("does not descend into excluded top-level dirs (projects/, sessions/, plugins/cache)", () => {
    const target = join(externalDir, "leak");
    mkdirSync(target);
    mkdirSync(join(claudeDir, "projects"));
    mkdirSync(join(claudeDir, "sessions"));
    mkdirSync(join(claudeDir, "plugins", "cache"), { recursive: true });
    symlinkSync(target, join(claudeDir, "projects", "x"));
    symlinkSync(target, join(claudeDir, "sessions", "x"));
    symlinkSync(target, join(claudeDir, "plugins", "cache", "x"));
    expect(scanEscapingSymlinks(claudeDir)).toEqual([]);
  });

  it("does descend into plugins/ but skips plugins/cache/", () => {
    const target = join(externalDir, "tgt");
    mkdirSync(target);
    mkdirSync(join(claudeDir, "plugins", "marketplaces"), { recursive: true });
    mkdirSync(join(claudeDir, "plugins", "cache"), { recursive: true });
    symlinkSync(target, join(claudeDir, "plugins", "marketplaces", "x"));
    symlinkSync(target, join(claudeDir, "plugins", "cache", "x"));
    const out = scanEscapingSymlinks(claudeDir);
    expect(out.map((e) => e.relPath)).toEqual(["plugins/marketplaces/x"]);
  });

  it("skips .git, .venv, venv at any depth", () => {
    const target = join(externalDir, "tgt");
    mkdirSync(target);
    mkdirSync(join(claudeDir, "agents", "skill", ".git"), { recursive: true });
    mkdirSync(join(claudeDir, "agents", "skill", ".venv"), { recursive: true });
    mkdirSync(join(claudeDir, "agents", "skill", "venv"), { recursive: true });
    symlinkSync(target, join(claudeDir, "agents", "skill", ".git", "x"));
    symlinkSync(target, join(claudeDir, "agents", "skill", ".venv", "x"));
    symlinkSync(target, join(claudeDir, "agents", "skill", "venv", "x"));
    expect(scanEscapingSymlinks(claudeDir)).toEqual([]);
  });
});

describe("buildClaudeSymlinkOverlay", () => {
  let root: string;
  let claudeDir: string;
  let externalDir: string;
  let stageDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccairgap-symlink-test-"));
    claudeDir = join(root, ".claude");
    externalDir = join(root, "ext");
    stageDir = join(root, "stage");
    mkdirSync(claudeDir, { recursive: true });
    mkdirSync(externalDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns no mounts when ~/.claude/ has no symlinks that leave it", async () => {
    const mounts = await buildClaudeSymlinkOverlay(claudeDir, stageDir);
    expect(mounts).toEqual([]);
  });

  it("materializes a directory symlink and emits one RO mount", async () => {
    const target = join(externalDir, "skill");
    mkdirSync(target);
    writeFileSync(join(target, "SKILL.md"), "hello\n");
    symlinkSync(target, join(claudeDir, "skills"));

    const mounts = await buildClaudeSymlinkOverlay(claudeDir, stageDir);
    expect(mounts).toHaveLength(1);
    const m = mounts[0]!;
    expect(m.dst).toBe("/host-claude/skills");
    expect(m.mode).toBe("ro");
    expect(m.source.kind).toBe("claude-symlink-overlay");
    // Materialized content is real, not a symlink
    const staged = readFileSync(join(stageDir, "skills", "SKILL.md"), "utf8");
    expect(staged).toBe("hello\n");
  });

  it("materializes a relative directory symlink whose target leaves ~/.claude/", async () => {
    const target = join(externalDir, "skill");
    mkdirSync(target);
    writeFileSync(join(target, "SKILL.md"), "rel\n");
    mkdirSync(join(claudeDir, "skills"));
    symlinkSync("../../ext/skill", join(claudeDir, "skills", "rel"));

    const mounts = await buildClaudeSymlinkOverlay(claudeDir, stageDir);
    expect(mounts.map((m) => m.dst)).toEqual(["/host-claude/skills/rel"]);
    expect(readFileSync(join(stageDir, "skills", "rel", "SKILL.md"), "utf8")).toBe("rel\n");
  });

  it("materializes a file symlink", async () => {
    const target = join(externalDir, "settings.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(claudeDir, "settings.json"));

    const mounts = await buildClaudeSymlinkOverlay(claudeDir, stageDir);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.dst).toBe("/host-claude/settings.json");
    expect(readFileSync(join(stageDir, "settings.json"), "utf8")).toBe("{}");
  });

  it("excludes .git / .venv / venv / node_modules / .DS_Store inside materialized dir", async () => {
    const target = join(externalDir, "skill");
    mkdirSync(target);
    writeFileSync(join(target, "keep.md"), "k");
    mkdirSync(join(target, ".git"));
    writeFileSync(join(target, ".git", "config"), "x");
    mkdirSync(join(target, ".venv"));
    writeFileSync(join(target, ".venv", "pyvenv.cfg"), "x");
    mkdirSync(join(target, "venv"));
    writeFileSync(join(target, "venv", "x"), "x");
    mkdirSync(join(target, "node_modules"));
    writeFileSync(join(target, "node_modules", "x"), "x");
    writeFileSync(join(target, ".DS_Store"), "x");
    symlinkSync(target, join(claudeDir, "skills"));

    await buildClaudeSymlinkOverlay(claudeDir, stageDir);
    const staged = join(stageDir, "skills");
    expect(readFileSync(join(staged, "keep.md"), "utf8")).toBe("k");
    // Existence of excluded paths in stage:
    const fs = await import("node:fs");
    expect(fs.existsSync(join(staged, ".git"))).toBe(false);
    expect(fs.existsSync(join(staged, ".venv"))).toBe(false);
    expect(fs.existsSync(join(staged, "venv"))).toBe(false);
    expect(fs.existsSync(join(staged, "node_modules"))).toBe(false);
    expect(fs.existsSync(join(staged, ".DS_Store"))).toBe(false);
  });

  it("warns and skips broken symlinks", async () => {
    symlinkSync("/nonexistent/path", join(claudeDir, "CLAUDE.md"));
    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      const mounts = await buildClaudeSymlinkOverlay(claudeDir, stageDir);
      expect(mounts).toEqual([]);
      expect(errors.some((e) => e.includes("missing on host"))).toBe(true);
    } finally {
      console.error = orig;
    }
  });

  it("warns and mounts the partial copy when a target contains a dangling symlink", async () => {
    // Real rsync: a dangling symlink under -L exits 23 on openrsync and GNU rsync.
    const target = join(externalDir, "skill");
    mkdirSync(target);
    writeFileSync(join(target, "SKILL.md"), "partial\n");
    symlinkSync("/nonexistent/path", join(target, "dangling"));
    symlinkSync(target, join(claudeDir, "skills"));

    const errors: string[] = [];
    const orig = console.error;
    console.error = (msg: string) => errors.push(msg);
    try {
      const mounts = await buildClaudeSymlinkOverlay(claudeDir, stageDir);
      expect(mounts.map((m) => m.dst)).toEqual(["/host-claude/skills"]);
      expect(readFileSync(join(stageDir, "skills", "SKILL.md"), "utf8")).toBe("partial\n");
      expect(errors.some((e) => e.includes("rsync exit 23") && e.includes("~/.claude/skills"))).toBe(
        true,
      );
    } finally {
      console.error = orig;
    }
  });
});
