import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyHookPolicy,
  enumerateHooks,
  filterHooksField,
  globToRegex,
  listDirectoryPlugins,
  matchesEnable,
} from "./hooks.js";

describe("globToRegex", () => {
  it("converts * to greedy wildcard and anchors", () => {
    const re = globToRegex("python3 *");
    expect(re.test("python3 /x/y")).toBe(true);
    expect(re.test("node foo.js")).toBe(false);
  });
  it("escapes regex metacharacters in literal segments", () => {
    const re = globToRegex("a.b+c");
    expect(re.test("a.b+c")).toBe(true);
    expect(re.test("aXbXc")).toBe(false);
  });
  it("handles bare *", () => {
    expect(globToRegex("*").test("anything")).toBe(true);
  });
});

describe("matchesEnable", () => {
  it("any-match semantics", () => {
    expect(matchesEnable("python3 x.py", ["node *", "python3 *"])).toBe(true);
    expect(matchesEnable("bash x.sh", ["node *"])).toBe(false);
  });
  it("empty globs never matches", () => {
    expect(matchesEnable("anything", [])).toBe(false);
  });
});

describe("filterHooksField", () => {
  const sample = {
    PreToolUse: [
      {
        matcher: "Bash",
        hooks: [
          { type: "command", command: "python3 deny.py" },
          { type: "command", command: "bash log.sh" },
        ],
      },
    ],
    Notification: [
      {
        hooks: [{ type: "command", command: "afplay /x.wav" }],
      },
    ],
  };
  it("drops entries whose command does not match any glob", () => {
    const out = filterHooksField(sample, ["python3 *"]);
    expect(out.PreToolUse).toHaveLength(1);
    expect(out.PreToolUse![0]!.hooks).toEqual([
      { type: "command", command: "python3 deny.py" },
    ]);
    expect(out.Notification).toBeUndefined();
  });
  it("drops matcher groups that become empty", () => {
    const out = filterHooksField(sample, ["nothing-matches"]);
    expect(out).toEqual({});
  });
  it("keeps everything when a catch-all glob is passed", () => {
    const out = filterHooksField(sample, ["*"]);
    expect(out.PreToolUse![0]!.hooks).toHaveLength(2);
    expect(out.Notification).toHaveLength(1);
  });
  it("tolerates non-object input", () => {
    expect(filterHooksField(null, ["*"])).toEqual({});
    expect(filterHooksField("x", ["*"])).toEqual({});
    expect(filterHooksField([], ["*"])).toEqual({});
  });
});

describe("listDirectoryPlugins", () => {
  let root: string;
  let hostClaude: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dp-test-"));
    hostClaude = join(root, "host-claude");
    mkdirSync(hostClaude, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeJSON(path: string, data: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  }

  it("returns each plugin declared in a directory-source marketplace", () => {
    const marketDir = join(root, "mkt");
    mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
    writeJSON(join(marketDir, ".claude-plugin", "marketplace.json"), {
      name: "switchboard",
      plugins: [
        { name: "switchboard", source: "./" },
        { name: "extra", source: "./plugins/extra" },
      ],
    });
    mkdirSync(join(marketDir, "plugins", "extra"), { recursive: true });
    writeJSON(join(hostClaude, "settings.json"), {
      extraKnownMarketplaces: {
        switchboard: { source: { source: "directory", path: marketDir } },
      },
    });

    const out = listDirectoryPlugins(hostClaude);
    expect(out).toHaveLength(2);
    const byKey = Object.fromEntries(out.map((p) => [p.key, p]));
    expect(byKey["switchboard@switchboard"]!.hostDir).toBe(realpathSync(marketDir));
    expect(byKey["extra@switchboard"]!.hostDir).toBe(
      realpathSync(join(marketDir, "plugins", "extra")),
    );
  });

  it("skips non-directory sources and missing marketplace.json", () => {
    writeJSON(join(hostClaude, "settings.json"), {
      extraKnownMarketplaces: {
        gh: { source: { source: "github", repo: "x/y" } },
        broken: { source: { source: "directory", path: join(root, "does-not-exist") } },
      },
    });
    expect(listDirectoryPlugins(hostClaude)).toEqual([]);
  });
});

describe("applyHookPolicy", () => {
  let root: string;
  let hostClaude: string;
  let pluginsCache: string;
  let sessionDir: string;
  const containerCache = "/home/claude/.claude/plugins/cache";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-test-"));
    hostClaude = join(root, "host-claude");
    pluginsCache = join(hostClaude, "plugins", "cache");
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

  it("empty enable list → disableAllHooks:true and no override mounts", () => {
    writeJSON(join(hostClaude, "settings.json"), {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "python3 x" }] }] },
      enabledPlugins: { "p@m": true },
    });
    mkdirSync(join(pluginsCache, "m", "p", "1.0.0", "hooks"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", "hooks", "hooks.json"), {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node a" }] }] },
    });
    const res = applyHookPolicy({
      policy: { enableGlobs: [] },
      sessionDir,
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });
    expect(res.overrideMounts).toEqual([]);
    const patched = JSON.parse(readFileSync(res.patchedUserSettingsPath, "utf8"));
    expect(patched.disableAllHooks).toBe(true);
    expect(patched.hooks).toEqual({});
  });

  it("non-empty enable filters user hooks and plugin hooks.json", () => {
    writeJSON(join(hostClaude, "settings.json"), {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "python3 deny.py" },
              { type: "command", command: "afplay ding.wav" },
            ],
          },
        ],
      },
      enabledPlugins: { "p@m": true, "off@m": true },
    });
    mkdirSync(join(pluginsCache, "m", "p", "1.0.0", "hooks"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", "hooks", "hooks.json"), {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: "python3 plugin-hook.py" },
              { type: "command", command: "switchboard-hook x" },
            ],
          },
        ],
      },
    });

    const res = applyHookPolicy({
      policy: { enableGlobs: ["python3 *"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });

    const patchedUser = JSON.parse(readFileSync(res.patchedUserSettingsPath, "utf8"));
    expect(patchedUser.disableAllHooks).toBe(false);
    expect(patchedUser.hooks.PreToolUse).toHaveLength(1);
    expect(patchedUser.hooks.PreToolUse[0].hooks).toEqual([
      { type: "command", command: "python3 deny.py" },
    ]);

    expect(res.overrideMounts).toHaveLength(1);
    const pm = res.overrideMounts[0]!;
    expect(pm.dst).toBe(`${containerCache}/m/p/1.0.0/hooks/hooks.json`);
    expect(pm.mode).toBe("ro");
    const patchedPlugin = JSON.parse(readFileSync(pm.src, "utf8"));
    expect(patchedPlugin.hooks.PreToolUse[0].hooks).toEqual([
      { type: "command", command: "python3 plugin-hook.py" },
    ]);
  });

  it("disabled plugins (enabledPlugins[key] !== true) are ignored", () => {
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "p@m": false },
    });
    mkdirSync(join(pluginsCache, "m", "p", "1.0.0", "hooks"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", "hooks", "hooks.json"), {
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "python3 x" }] }] },
    });
    const res = applyHookPolicy({
      policy: { enableGlobs: ["python3 *"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });
    expect(res.overrideMounts).toEqual([]);
  });

  it("directory-sourced plugin hooks.json gets overlaid at the plugin host path", () => {
    const marketDir = join(root, "markets", "switchboard");
    const pluginDir = marketDir; // `source: "./"` convention
    mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
    writeJSON(join(marketDir, ".claude-plugin", "marketplace.json"), {
      name: "switchboard",
      plugins: [{ name: "switchboard", source: "./" }],
    });
    mkdirSync(join(pluginDir, "hooks"), { recursive: true });
    writeJSON(join(pluginDir, "hooks", "hooks.json"), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "switchboard-hook" },
              { type: "command", command: "python3 keep.py" },
            ],
          },
        ],
      },
    });
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "switchboard@switchboard": true },
      extraKnownMarketplaces: {
        switchboard: { source: { source: "directory", path: marketDir } },
      },
    });

    const res = applyHookPolicy({
      policy: { enableGlobs: ["python3 *"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });

    const dp = res.overrideMounts.find(
      (m) => m.dst === join(realpathSync(pluginDir), "hooks", "hooks.json"),
    );
    expect(dp).toBeDefined();
    expect(dp!.mode).toBe("ro");
    const patched = JSON.parse(readFileSync(dp!.src, "utf8"));
    expect(patched.hooks.SessionStart[0].hooks).toEqual([
      { type: "command", command: "python3 keep.py" },
    ]);
  });

  it("directory plugin overlay is skipped when plugin is not enabled", () => {
    const marketDir = join(root, "markets", "off");
    mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
    writeJSON(join(marketDir, ".claude-plugin", "marketplace.json"), {
      name: "off",
      plugins: [{ name: "off", source: "./" }],
    });
    mkdirSync(join(marketDir, "hooks"), { recursive: true });
    writeJSON(join(marketDir, "hooks", "hooks.json"), {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "python3 x" }] }] },
    });
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "off@off": false },
      extraKnownMarketplaces: {
        off: { source: { source: "directory", path: marketDir } },
      },
    });
    const res = applyHookPolicy({
      policy: { enableGlobs: ["python3 *"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [],
    });
    expect(res.overrideMounts).toEqual([]);
  });

  it("project settings.json in each session clone gets its own overlay mount", () => {
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: {} });
    const sessionClone = join(root, "session", "repos", "myrepo");
    mkdirSync(join(sessionClone, ".claude"), { recursive: true });
    writeJSON(join(sessionClone, ".claude", "settings.json"), {
      hooks: {
        PreToolUse: [
          {
            hooks: [
              { type: "command", command: "python3 project.py" },
              { type: "command", command: "bash other.sh" },
            ],
          },
        ],
      },
    });

    const res = applyHookPolicy({
      policy: { enableGlobs: ["python3 *"] },
      sessionDir,
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: containerCache,
      repos: [
        {
          basename: "myrepo",
          sessionClonePath: sessionClone,
          hostPath: "/Users/x/src/myrepo",
        },
      ],
    });

    const projMount = res.overrideMounts.find((m) =>
      m.dst.endsWith("/myrepo/.claude/settings.json"),
    );
    expect(projMount).toBeDefined();
    expect(projMount!.dst).toBe("/Users/x/src/myrepo/.claude/settings.json");
    const patchedProj = JSON.parse(readFileSync(projMount!.src, "utf8"));
    expect(patchedProj.hooks.PreToolUse[0].hooks).toEqual([
      { type: "command", command: "python3 project.py" },
    ]);
  });
});

describe("enumerateHooks", () => {
  let root: string;
  let hostClaude: string;
  let pluginsCache: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "hooks-enum-"));
    hostClaude = join(root, "host-claude");
    pluginsCache = join(hostClaude, "plugins", "cache");
    mkdirSync(pluginsCache, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeJSON(path: string, data: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  }

  it("returns user, enabled-plugin, and per-repo project hook entries with source attribution", () => {
    writeJSON(join(hostClaude, "settings.json"), {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "python3 user.py" },
              { type: "command", command: "afplay ding.wav" },
            ],
          },
        ],
      },
      enabledPlugins: { "p@m": true, "off@m": false },
    });

    // Enabled plugin with hooks.
    mkdirSync(join(pluginsCache, "m", "p", "1.0.0", "hooks"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", "hooks", "hooks.json"), {
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "node plugin.js" }] }],
      },
    });
    // Disabled plugin — hooks should NOT appear.
    mkdirSync(join(pluginsCache, "m", "off", "1.0.0", "hooks"), { recursive: true });
    writeJSON(join(pluginsCache, "m", "off", "1.0.0", "hooks", "hooks.json"), {
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "should-not-appear" }] }],
      },
    });

    const repoDir = join(root, "repos", "myrepo");
    mkdirSync(join(repoDir, ".claude"), { recursive: true });
    writeJSON(join(repoDir, ".claude", "settings.json"), {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "bash shared.sh" }] }],
      },
    });
    writeJSON(join(repoDir, ".claude", "settings.local.json"), {
      hooks: {
        Notification: [{ hooks: [{ type: "command", command: "osascript local.scpt" }] }],
      },
    });

    const records = enumerateHooks({
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      repos: [{ basename: "myrepo", hostPath: repoDir }],
    });

    const commands = records.map((r) => r.command).sort();
    expect(commands).toEqual([
      "afplay ding.wav",
      "bash shared.sh",
      "node plugin.js",
      "osascript local.scpt",
      "python3 user.py",
    ]);

    const byCommand = Object.fromEntries(records.map((r) => [r.command, r]));
    expect(byCommand["python3 user.py"]!.source).toBe("user");
    expect(byCommand["python3 user.py"]!.event).toBe("PreToolUse");
    expect(byCommand["python3 user.py"]!.matcher).toBe("Bash");

    expect(byCommand["node plugin.js"]!.source).toBe("plugin");
    expect(byCommand["node plugin.js"]!.plugin).toEqual({
      marketplace: "m",
      plugin: "p",
      version: "1.0.0",
    });

    expect(byCommand["bash shared.sh"]!.source).toBe("project");
    expect(byCommand["bash shared.sh"]!.repo).toBe("myrepo");
    expect(byCommand["bash shared.sh"]!.sourcePath).toBe(
      join(repoDir, ".claude", "settings.json"),
    );
    expect(byCommand["osascript local.scpt"]!.sourcePath).toBe(
      join(repoDir, ".claude", "settings.local.json"),
    );
  });

  it("returns empty array when no hook sources exist", () => {
    const records = enumerateHooks({
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      repos: [],
    });
    expect(records).toEqual([]);
  });

  it("includes directory-sourced plugin hooks when the plugin is enabled", () => {
    const marketDir = join(root, "markets", "switchboard");
    mkdirSync(join(marketDir, ".claude-plugin"), { recursive: true });
    writeJSON(join(marketDir, ".claude-plugin", "marketplace.json"), {
      name: "switchboard",
      plugins: [{ name: "switchboard", source: "./" }],
    });
    mkdirSync(join(marketDir, "hooks"), { recursive: true });
    writeJSON(join(marketDir, "hooks", "hooks.json"), {
      hooks: {
        SessionStart: [{ hooks: [{ type: "command", command: "switchboard-hook" }] }],
      },
    });
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "switchboard@switchboard": true },
      extraKnownMarketplaces: {
        switchboard: { source: { source: "directory", path: marketDir } },
      },
    });

    const records = enumerateHooks({
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      repos: [],
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.command).toBe("switchboard-hook");
    expect(records[0]!.source).toBe("plugin");
    expect(records[0]!.plugin).toEqual({
      marketplace: "switchboard",
      plugin: "switchboard",
      version: "directory",
    });
  });

  it("tolerates missing settings.json, missing plugins cache, and repos without .claude/", () => {
    const missingCache = join(root, "no-such-cache");
    const repoDir = join(root, "repo-without-claude-dir");
    mkdirSync(repoDir, { recursive: true });
    const records = enumerateHooks({
      hostClaudeDir: join(root, "no-claude"),
      pluginsCacheDir: missingCache,
      repos: [{ basename: "x", hostPath: repoDir }],
    });
    expect(records).toEqual([]);
  });
});
