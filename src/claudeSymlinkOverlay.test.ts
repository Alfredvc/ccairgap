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
  scanAbsoluteSymlinks,
} from "./claudeSymlinkOverlay.js";

describe("scanAbsoluteSymlinks", () => {
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
    expect(scanAbsoluteSymlinks(claudeDir)).toEqual([]);
  });

  it("returns empty array when ~/.claude/ does not exist", () => {
    expect(scanAbsoluteSymlinks(join(root, "nope"))).toEqual([]);
  });

  it("finds absolute symlinks at top level", () => {
    const target = join(externalDir, "skill");
    mkdirSync(target);
    symlinkSync(target, join(claudeDir, "skills"));
    const out = scanAbsoluteSymlinks(claudeDir);
    expect(out).toHaveLength(1);
    expect(out[0]?.relPath).toBe("skills");
    expect(out[0]?.rawTarget).toBe(target);
  });

  it("finds absolute symlinks nested inside subdirectories", () => {
    mkdirSync(join(claudeDir, "skills"));
    const target = join(externalDir, "ccairgap-configure");
    mkdirSync(target);
    symlinkSync(target, join(claudeDir, "skills", "ccairgap-configure"));
    const out = scanAbsoluteSymlinks(claudeDir);
    expect(out).toHaveLength(1);
    expect(out[0]?.relPath).toBe("skills/ccairgap-configure");
  });

  it("skips relative symlinks", () => {
    mkdirSync(join(claudeDir, "real"));
    symlinkSync("real", join(claudeDir, "alias"));
    expect(scanAbsoluteSymlinks(claudeDir)).toEqual([]);
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
    expect(scanAbsoluteSymlinks(claudeDir)).toEqual([]);
  });

  it("does descend into plugins/ but skips plugins/cache/", () => {
    const target = join(externalDir, "tgt");
    mkdirSync(target);
    mkdirSync(join(claudeDir, "plugins", "marketplaces"), { recursive: true });
    mkdirSync(join(claudeDir, "plugins", "cache"), { recursive: true });
    symlinkSync(target, join(claudeDir, "plugins", "marketplaces", "x"));
    symlinkSync(target, join(claudeDir, "plugins", "cache", "x"));
    const out = scanAbsoluteSymlinks(claudeDir);
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
    expect(scanAbsoluteSymlinks(claudeDir)).toEqual([]);
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

  it("returns no mounts when ~/.claude/ has no absolute symlinks", async () => {
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
    symlinkSync(target, join(claudeDir, "skill"));

    await buildClaudeSymlinkOverlay(claudeDir, stageDir);
    const staged = join(stageDir, "skill");
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
    symlinkSync("/nonexistent/path", join(claudeDir, "broken"));
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
});
