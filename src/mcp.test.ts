import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enumerateMcpServers } from "./mcp.js";

describe("enumerateMcpServers", () => {
  let root: string;
  let hostClaude: string;
  let pluginsCache: string;
  let claudeJsonPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-enum-"));
    hostClaude = join(root, "host-claude");
    pluginsCache = join(hostClaude, "plugins", "cache");
    claudeJsonPath = join(root, ".claude.json");
    mkdirSync(pluginsCache, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeJSON(path: string, data: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  }

  it("emits user, user-project, project, and plugin records with correct attribution", () => {
    const repoDir = join(root, "src", "myrepo");
    mkdirSync(repoDir, { recursive: true });

    writeJSON(claudeJsonPath, {
      mcpServers: {
        "user-global": { command: "node", args: ["g.js"] },
      },
      projects: {
        [repoDir]: {
          mcpServers: {
            "user-local": { command: "python3", args: ["l.py"] },
          },
        },
      },
    });

    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "p@m": true },
      enabledMcpjsonServers: ["shared-approved"],
    });

    writeJSON(join(repoDir, ".mcp.json"), {
      mcpServers: {
        "shared-approved": { command: "uv", args: ["run", "foo"] },
        "shared-unapproved": { command: "npx", args: ["bar"] },
      },
    });

    mkdirSync(join(pluginsCache, "m", "p", "1.0.0"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", ".mcp.json"), {
      mcpServers: { "plugin-file": { command: "plugin-bin" } },
    });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", "plugin.json"), {
      mcpServers: { "plugin-inline": { command: "inline-bin" } },
    });

    const records = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      repos: [{ basename: "myrepo", hostPath: repoDir }],
    });

    const byName = Object.fromEntries(records.map((r) => [r.name, r]));

    expect(byName["user-global"]!.source).toBe("user");
    expect(byName["user-global"]!.definition).toEqual({ command: "node", args: ["g.js"] });

    expect(byName["user-local"]!.source).toBe("user-project");
    expect(byName["user-local"]!.repo).toBe("myrepo");
    expect(byName["user-local"]!.projectPath).toBe(repoDir);

    expect(byName["shared-approved"]!.source).toBe("project");
    expect(byName["shared-approved"]!.repo).toBe("myrepo");
    expect(byName["shared-approved"]!.approvalState).toBe("approved");
    expect(byName["shared-approved"]!.sourcePath).toBe(join(repoDir, ".mcp.json"));

    expect(byName["shared-unapproved"]!.approvalState).toBe("unapproved");

    expect(byName["plugin-file"]!.source).toBe("plugin");
    expect(byName["plugin-file"]!.plugin).toEqual({
      marketplace: "m",
      plugin: "p",
      version: "1.0.0",
    });
    expect(byName["plugin-inline"]!.source).toBe("plugin");
  });

  it("derives approvalState: denied wins over enabled / enableAll", () => {
    const repoDir = join(root, "r");
    mkdirSync(repoDir, { recursive: true });
    writeJSON(claudeJsonPath, {});
    writeJSON(join(hostClaude, "settings.json"), {
      enableAllProjectMcpServers: true,
      disabledMcpjsonServers: ["bad"],
    });
    writeJSON(join(repoDir, ".mcp.json"), {
      mcpServers: { bad: { command: "x" }, good: { command: "y" } },
    });

    const records = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      repos: [{ basename: "r", hostPath: repoDir }],
    });
    const by = Object.fromEntries(records.map((r) => [r.name, r]));
    expect(by.bad!.approvalState).toBe("denied");
    expect(by.good!.approvalState).toBe("approved");
  });

  it("derives approvalState: enableAllProjectMcpServers approves everything absent a deny", () => {
    const repoDir = join(root, "r");
    mkdirSync(repoDir, { recursive: true });
    writeJSON(claudeJsonPath, {});
    writeJSON(join(hostClaude, "settings.json"), { enableAllProjectMcpServers: true });
    writeJSON(join(repoDir, ".mcp.json"), {
      mcpServers: { a: { command: "x" }, b: { command: "y" } },
    });

    const records = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      repos: [{ basename: "r", hostPath: repoDir }],
    });
    for (const r of records) expect(r.approvalState).toBe("approved");
  });

  it("reads approvals from ~/.claude.json projects entry and from project settings.local.json", () => {
    const repoDir = join(root, "r");
    mkdirSync(repoDir, { recursive: true });
    writeJSON(claudeJsonPath, {
      projects: {
        [repoDir]: { enabledMcpjsonServers: ["via-claude-json"] },
      },
    });
    writeJSON(join(hostClaude, "settings.json"), {});
    writeJSON(join(repoDir, ".claude", "settings.local.json"), {
      enabledMcpjsonServers: ["via-local"],
    });
    writeJSON(join(repoDir, ".mcp.json"), {
      mcpServers: {
        "via-claude-json": { command: "a" },
        "via-local": { command: "b" },
        unapproved: { command: "c" },
      },
    });

    const records = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      repos: [{ basename: "r", hostPath: repoDir }],
    });
    const by = Object.fromEntries(records.map((r) => [r.name, r]));
    expect(by["via-claude-json"]!.approvalState).toBe("approved");
    expect(by["via-local"]!.approvalState).toBe("approved");
    expect(by.unapproved!.approvalState).toBe("unapproved");
  });

  it("ignores MCP servers on disabled plugins", () => {
    writeJSON(claudeJsonPath, {});
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "p@m": false },
    });
    mkdirSync(join(pluginsCache, "m", "p", "1.0.0"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", ".mcp.json"), {
      mcpServers: { should: { command: "not-appear" } },
    });

    const records = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      repos: [],
    });
    expect(records).toEqual([]);
  });

  it("tolerates missing ~/.claude.json, missing settings, missing plugins cache, repos without .mcp.json", () => {
    const repoDir = join(root, "r");
    mkdirSync(repoDir, { recursive: true });
    const records = enumerateMcpServers({
      hostClaudeDir: join(root, "no-claude-dir"),
      hostClaudeJsonPath: join(root, "no-claude.json"),
      pluginsCacheDir: join(root, "no-cache"),
      repos: [{ basename: "r", hostPath: repoDir }],
    });
    expect(records).toEqual([]);
  });

  it("matches user-project entries to repos by realpath (handles symlinks / ../ paths)", () => {
    const realRepo = join(root, "real", "repo");
    mkdirSync(realRepo, { recursive: true });
    // The project key uses a non-canonical path; the repo is passed with a different
    // spelling. Realpath resolution must match them.
    const nonCanonical = join(root, "real", ".", "repo");
    writeJSON(claudeJsonPath, {
      projects: {
        [nonCanonical]: {
          mcpServers: { scoped: { command: "x" } },
        },
      },
    });
    writeJSON(join(hostClaude, "settings.json"), {});

    const records = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      repos: [{ basename: "repo", hostPath: realRepo }],
    });
    const rec = records.find((r) => r.name === "scoped")!;
    expect(rec.source).toBe("user-project");
    expect(rec.repo).toBe("repo");
  });

  it("skips non-object mcpServer definitions", () => {
    writeJSON(claudeJsonPath, {
      mcpServers: {
        ok: { command: "x" },
        bad: "this-is-not-an-object",
        alsoBad: null,
      },
    });
    writeJSON(join(hostClaude, "settings.json"), {});

    const records = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      repos: [],
    });
    expect(records.map((r) => r.name)).toEqual(["ok"]);
  });
});
