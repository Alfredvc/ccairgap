import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyHookPolicy, filterHooksField, globToRegex, matchesEnable } from "./hooks.js";

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
