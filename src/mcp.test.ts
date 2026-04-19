import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMcpPolicy, enumerateMcpServers } from "./mcp.js";

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

  it("emits plugin MCP records for directory-sourced marketplaces", () => {
    const marketDir = join(root, "markets", "switchboard");
    mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
    writeJSON(join(marketDir, ".claude-plugin", "marketplace.json"), {
      name: "switchboard",
      plugins: [
        { name: "switchboard", source: "./" },
        { name: "extra", source: "./plugins/extra" },
      ],
    });
    // switchboard plugin carries both .mcp.json and plugin.json#mcpServers.
    writeJSON(join(marketDir, ".mcp.json"), {
      mcpServers: { "sb-file": { command: "sb-bin" } },
    });
    writeJSON(join(marketDir, "plugin.json"), {
      mcpServers: { "sb-inline": { command: "sb-inline-bin" } },
    });
    // extra plugin carries only .mcp.json.
    mkdirSync(join(marketDir, "plugins", "extra"), { recursive: true });
    writeJSON(join(marketDir, "plugins", "extra", ".mcp.json"), {
      mcpServers: { "extra-file": { command: "extra-bin" } },
    });

    writeJSON(claudeJsonPath, {});
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: {
        "switchboard@switchboard": true,
        "extra@switchboard": true,
      },
      extraKnownMarketplaces: {
        switchboard: { source: { source: "directory", path: marketDir } },
      },
    });

    const records = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      repos: [],
    });
    const by = Object.fromEntries(records.map((r) => [r.name, r]));

    expect(by["sb-file"]!.source).toBe("plugin");
    expect(by["sb-file"]!.plugin).toEqual({
      marketplace: "switchboard",
      plugin: "switchboard",
      version: "directory",
    });
    expect(by["sb-inline"]!.source).toBe("plugin");
    expect(by["sb-inline"]!.plugin!.plugin).toBe("switchboard");
    expect(by["extra-file"]!.plugin).toEqual({
      marketplace: "switchboard",
      plugin: "extra",
      version: "directory",
    });
  });

  it("skips directory-sourced plugin MCP when plugin is not enabled", () => {
    const marketDir = join(root, "markets", "off");
    mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
    writeJSON(join(marketDir, ".claude-plugin", "marketplace.json"), {
      name: "off",
      plugins: [{ name: "off", source: "./" }],
    });
    writeJSON(join(marketDir, ".mcp.json"), {
      mcpServers: { hidden: { command: "nope" } },
    });

    writeJSON(claudeJsonPath, {});
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "off@off": false },
      extraKnownMarketplaces: {
        off: { source: { source: "directory", path: marketDir } },
      },
    });

    const records = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      repos: [],
    });
    expect(records).toEqual([]);
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

describe("applyMcpPolicy", () => {
  let root: string;
  let hostClaude: string;
  let pluginsCache: string;
  let claudeJsonPath: string;
  let sessionDir: string;
  const containerCache = "/home/claude/.claude/plugins/cache";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mcp-policy-"));
    hostClaude = join(root, "host-claude");
    pluginsCache = join(hostClaude, "plugins", "cache");
    claudeJsonPath = join(root, ".claude.json");
    sessionDir = join(root, "session");
    mkdirSync(pluginsCache, { recursive: true });
    mkdirSync(sessionDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeJSON(path: string, data: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  }

  it("empty enable → every mcpServers field is {} across all sources", () => {
    writeJSON(claudeJsonPath, {
      mcpServers: { "user-global": { command: "x" } },
      projects: {
        "/some/repo": {
          mcpServers: { "user-local": { command: "y" } },
          hasTrustDialogAccepted: true,
        },
      },
    });
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "p@m": true },
    });
    mkdirSync(join(pluginsCache, "m", "p", "1.0.0"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", ".mcp.json"), {
      mcpServers: { "plugin-srv": { command: "z" } },
    });

    const res = applyMcpPolicy({
      policy: { enableGlobs: [] },
      sessionDir,
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });

    const patched = JSON.parse(readFileSync(res.patchedClaudeJsonPath, "utf8"));
    expect(patched.mcpServers).toEqual({});
    expect(patched.projects["/some/repo"].mcpServers).toEqual({});
    // Non-mcp keys survive.
    expect(patched.projects["/some/repo"].hasTrustDialogAccepted).toBe(true);

    // Plugin overlay produced, empty mcpServers.
    const pluginMount = res.overrideMounts.find(
      (m) => m.dst === `${containerCache}/m/p/1.0.0/.mcp.json`,
    );
    expect(pluginMount).toBeDefined();
    const pluginPatched = JSON.parse(readFileSync(pluginMount!.src, "utf8"));
    expect(pluginPatched.mcpServers).toEqual({});
  });

  it("glob matches user + user-project by name", () => {
    writeJSON(claudeJsonPath, {
      mcpServers: {
        grafana: { command: "g" },
        other: { command: "o" },
      },
      projects: {
        "/r": {
          mcpServers: {
            grafana: { command: "g2" },
            random: { command: "r" },
          },
        },
      },
    });
    writeJSON(join(hostClaude, "settings.json"), {});

    const res = applyMcpPolicy({
      policy: { enableGlobs: ["grafana"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });

    const patched = JSON.parse(readFileSync(res.patchedClaudeJsonPath, "utf8"));
    expect(Object.keys(patched.mcpServers)).toEqual(["grafana"]);
    expect(Object.keys(patched.projects["/r"].mcpServers)).toEqual(["grafana"]);
  });

  it("plugin filter: enabled plugin keeps glob-matching mcpServers, disabled plugin skipped", () => {
    writeJSON(claudeJsonPath, {});
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "on@m": true, "off@m": false },
    });

    mkdirSync(join(pluginsCache, "m", "on", "1.0.0"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "on", "1.0.0", ".mcp.json"), {
      mcpServers: {
        keep: { command: "k" },
        drop: { command: "d" },
      },
    });
    writeJSON(join(pluginsCache, "m", "on", "1.0.0", "plugin.json"), {
      name: "on",
      mcpServers: { inline: { command: "i" } },
    });

    mkdirSync(join(pluginsCache, "m", "off", "1.0.0"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "off", "1.0.0", ".mcp.json"), {
      mcpServers: { keep: { command: "shouldnotappear" } },
    });

    const res = applyMcpPolicy({
      policy: { enableGlobs: ["keep", "inline"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });

    // Only the enabled plugin yields overlays (.mcp.json + plugin.json).
    const dsts = res.overrideMounts.map((m) => m.dst);
    expect(dsts).toContain(`${containerCache}/m/on/1.0.0/.mcp.json`);
    expect(dsts).toContain(`${containerCache}/m/on/1.0.0/plugin.json`);
    expect(dsts.some((d) => d.includes("/off/"))).toBe(false);

    const fileMount = res.overrideMounts.find(
      (m) => m.dst === `${containerCache}/m/on/1.0.0/.mcp.json`,
    )!;
    const filePatched = JSON.parse(readFileSync(fileMount.src, "utf8"));
    expect(Object.keys(filePatched.mcpServers)).toEqual(["keep"]);

    const inlineMount = res.overrideMounts.find(
      (m) => m.dst === `${containerCache}/m/on/1.0.0/plugin.json`,
    )!;
    const inlinePatched = JSON.parse(readFileSync(inlineMount.src, "utf8"));
    expect(Object.keys(inlinePatched.mcpServers)).toEqual(["inline"]);
    // Non-mcp keys on plugin.json survive.
    expect(inlinePatched.name).toBe("on");
  });

  it("directory-sourced plugin .mcp.json overlaid at the plugin host path", () => {
    const marketDir = join(root, "markets", "sb");
    mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
    writeJSON(join(marketDir, ".claude-plugin", "marketplace.json"), {
      name: "sb",
      plugins: [{ name: "sb", source: "./" }],
    });
    writeJSON(join(marketDir, ".mcp.json"), {
      mcpServers: {
        grafana: { command: "g" },
        other: { command: "o" },
      },
    });
    writeJSON(claudeJsonPath, {});
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "sb@sb": true },
      extraKnownMarketplaces: {
        sb: { source: { source: "directory", path: marketDir } },
      },
    });

    const res = applyMcpPolicy({
      policy: { enableGlobs: ["grafana"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });

    const overlay = res.overrideMounts.find(
      (m) => m.dst === join(realpathSync(marketDir), ".mcp.json"),
    );
    expect(overlay).toBeDefined();
    expect(overlay!.mode).toBe("ro");
    const patched = JSON.parse(readFileSync(overlay!.src, "utf8"));
    expect(Object.keys(patched.mcpServers)).toEqual(["grafana"]);
  });

  it("project scope: glob match is NOT enough — host approval is also required", () => {
    const hostRepo = join(root, "repo");
    const sessionClone = join(sessionDir, "repos", "repo");
    mkdirSync(hostRepo, { recursive: true });
    mkdirSync(sessionClone, { recursive: true });

    // host approval: approve `good`, nothing for `bad`.
    writeJSON(join(hostClaude, "settings.json"), {
      enabledMcpjsonServers: ["good"],
    });
    writeJSON(claudeJsonPath, {});

    // .mcp.json in the session clone (simulates a committed file post-clone).
    writeJSON(join(sessionClone, ".mcp.json"), {
      mcpServers: {
        good: { command: "g" },
        bad: { command: "b" },
      },
    });

    // Enable glob matches BOTH servers, but only `good` is approved.
    const res = applyMcpPolicy({
      policy: { enableGlobs: ["*"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [
        {
          basename: "repo",
          sessionClonePath: sessionClone,
          hostPath: hostRepo,
          alternatesName: "repo-aaaaaaaa",
        },
      ],
    });

    const projMount = res.overrideMounts.find(
      (m) => m.dst === join(hostRepo, ".mcp.json"),
    );
    expect(projMount).toBeDefined();
    const patched = JSON.parse(readFileSync(projMount!.src, "utf8"));
    expect(Object.keys(patched.mcpServers)).toEqual(["good"]);
  });

  it("project scope: enableAllProjectMcpServers approves everything, glob still filters", () => {
    const hostRepo = join(root, "repo");
    const sessionClone = join(sessionDir, "repos", "repo");
    mkdirSync(hostRepo, { recursive: true });
    mkdirSync(sessionClone, { recursive: true });

    writeJSON(join(hostClaude, "settings.json"), {
      enableAllProjectMcpServers: true,
    });
    writeJSON(claudeJsonPath, {});
    writeJSON(join(sessionClone, ".mcp.json"), {
      mcpServers: {
        grafana: { command: "g" },
        slack: { command: "s" },
      },
    });

    const res = applyMcpPolicy({
      policy: { enableGlobs: ["grafana"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [
        {
          basename: "repo",
          sessionClonePath: sessionClone,
          hostPath: hostRepo,
          alternatesName: "repo-aaaaaaaa",
        },
      ],
    });

    const projMount = res.overrideMounts.find(
      (m) => m.dst === join(hostRepo, ".mcp.json"),
    )!;
    const patched = JSON.parse(readFileSync(projMount.src, "utf8"));
    expect(Object.keys(patched.mcpServers)).toEqual(["grafana"]);
  });

  it("project scope: disabledMcpjsonServers wins over glob + enable-all", () => {
    const hostRepo = join(root, "repo");
    const sessionClone = join(sessionDir, "repos", "repo");
    mkdirSync(hostRepo, { recursive: true });
    mkdirSync(sessionClone, { recursive: true });

    writeJSON(join(hostClaude, "settings.json"), {
      enableAllProjectMcpServers: true,
      disabledMcpjsonServers: ["blocked"],
    });
    writeJSON(claudeJsonPath, {});
    writeJSON(join(sessionClone, ".mcp.json"), {
      mcpServers: {
        allowed: { command: "a" },
        blocked: { command: "b" },
      },
    });

    const res = applyMcpPolicy({
      policy: { enableGlobs: ["*"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [
        {
          basename: "repo",
          sessionClonePath: sessionClone,
          hostPath: hostRepo,
          alternatesName: "repo-aaaaaaaa",
        },
      ],
    });

    const projMount = res.overrideMounts.find(
      (m) => m.dst === join(hostRepo, ".mcp.json"),
    )!;
    const patched = JSON.parse(readFileSync(projMount.src, "utf8"));
    expect(Object.keys(patched.mcpServers)).toEqual(["allowed"]);
  });

  it("missing ~/.claude.json still yields a patched copy with empty mcpServers", () => {
    writeJSON(join(hostClaude, "settings.json"), {});

    const res = applyMcpPolicy({
      policy: { enableGlobs: ["*"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath, // file doesn't exist
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });

    const patched = JSON.parse(readFileSync(res.patchedClaudeJsonPath, "utf8"));
    expect(patched.mcpServers).toEqual({});
    expect(res.overrideMounts).toEqual([]);
  });

  it("skipped entirely when <repo>/.mcp.json does not exist", () => {
    const hostRepo = join(root, "repo");
    const sessionClone = join(sessionDir, "repos", "repo");
    mkdirSync(hostRepo, { recursive: true });
    mkdirSync(sessionClone, { recursive: true });

    writeJSON(join(hostClaude, "settings.json"), {});
    writeJSON(claudeJsonPath, {});

    const res = applyMcpPolicy({
      policy: { enableGlobs: ["*"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: claudeJsonPath,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [
        {
          basename: "repo",
          sessionClonePath: sessionClone,
          hostPath: hostRepo,
          alternatesName: "repo-aaaaaaaa",
        },
      ],
    });

    expect(res.overrideMounts.some((m) => m.dst.endsWith("/.mcp.json"))).toBe(false);
  });
});
