import { describe, expect, it } from "vitest";
import { hostClaudeDir, hostClaudeJson } from "./paths.js";

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

describe("hostClaudeJson", () => {
  it("defaults to $HOME/.claude.json when CLAUDE_CONFIG_DIR is unset", () => {
    expect(hostClaudeJson({ HOME: "/home/alice" })).toBe("/home/alice/.claude.json");
  });

  it("uses <CLAUDE_CONFIG_DIR>/.claude.json when set", () => {
    expect(hostClaudeJson({ HOME: "/home/alice", CLAUDE_CONFIG_DIR: "/etc/claude-work" }))
      .toBe("/etc/claude-work/.claude.json");
  });
});
