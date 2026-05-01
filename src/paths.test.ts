import { describe, expect, it } from "vitest";
import { encodeCwd, hostClaudeDir, hostClaudeJson } from "./paths.js";

describe("hostClaudeDir", () => {
  it("defaults to $HOME/.claude when CLAUDE_CONFIG_DIR is unset", () => {
    expect(hostClaudeDir({ HOME: "/home/alice" })).toBe("/home/alice/.claude");
  });

  it("uses CLAUDE_CONFIG_DIR when set", () => {
    expect(hostClaudeDir({ HOME: "/home/alice", CLAUDE_CONFIG_DIR: "/etc/claude-work" }))
      .toBe("/etc/claude-work");
  });

  it("treats empty CLAUDE_CONFIG_DIR as unset", () => {
    expect(hostClaudeDir({ HOME: "/home/alice", CLAUDE_CONFIG_DIR: "" }))
      .toBe("/home/alice/.claude");
  });
});

describe("encodeCwd", () => {
  it("replaces slashes with hyphens", () => {
    expect(encodeCwd("/Users/alice/src/proj")).toBe("-Users-alice-src-proj");
  });

  it("replaces underscores with hyphens (matches Claude Code sanitizePath)", () => {
    expect(encodeCwd("/Users/alice/src/chess_autocomplete")).toBe(
      "-Users-alice-src-chess-autocomplete",
    );
  });

  it("replaces dots and other non-alphanumerics with hyphens", () => {
    expect(encodeCwd("/Users/alice/src/.claude-worktrees/foo.bar")).toBe(
      "-Users-alice-src--claude-worktrees-foo-bar",
    );
  });

  it("truncates and appends djb2 hash for paths >200 chars sanitized", () => {
    const long = "/" + "a".repeat(250);
    const encoded = encodeCwd(long);
    expect(encoded.length).toBeGreaterThan(200);
    expect(encoded.length).toBeLessThanOrEqual(200 + 1 + 8);
    expect(encoded.slice(0, 200)).toBe("-" + "a".repeat(199));
    expect(encoded.charAt(200)).toBe("-");
    expect(encoded.slice(201)).toMatch(/^[0-9a-z]+$/);
  });

  it("hash is deterministic for the same input", () => {
    const long = "/" + "x".repeat(250);
    expect(encodeCwd(long)).toBe(encodeCwd(long));
  });
});

describe("hostClaudeJson", () => {
  it("defaults to $HOME/.claude.json when CLAUDE_CONFIG_DIR is unset", () => {
    expect(hostClaudeJson({ HOME: "/home/alice" })).toBe("/home/alice/.claude.json");
  });

  it("uses <CLAUDE_CONFIG_DIR>/.claude.json when set", () => {
    expect(hostClaudeJson({ HOME: "/home/alice", CLAUDE_CONFIG_DIR: "/etc/claude-work" }))
      .toBe("/etc/claude-work/.claude.json");
  });
});
