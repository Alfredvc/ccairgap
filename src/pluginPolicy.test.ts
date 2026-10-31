import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enumerateHooks } from "./hooks.js";
import { enumerateMcpServers } from "./mcp.js";
import { applyPluginPolicy } from "./pluginPolicy.js";
import { classifyManifestField, listCachePluginRoots, resolveComponentPath } from "./pluginRoots.js";
import type { Mount } from "./mounts.js";

const containerCache = "/home/claude/.claude/plugins/cache";

let root: string;
let hostClaude: string;
let pluginsCache: string;
let sessionDir: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "plugin-policy-")));
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

function hooksFile(...commands: string[]): unknown {
  return {
    hooks: {
      PreToolUse: [{ hooks: commands.map((command) => ({ type: "command", command })) }],
    },
  };
}

function installRecords(records: Record<string, string[]>): void {
  writeJSON(join(hostClaude, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: Object.fromEntries(
      Object.entries(records).map(([key, paths]) => [
        key,
        paths.map((installPath) => ({ scope: "user", installPath, version: "x" })),
      ]),
    ),
  });
}

function run(hookEnableGlobs: string[] = [], mcpEnableGlobs: string[] = []): Mount[] {
  return applyPluginPolicy({
    hookEnableGlobs,
    mcpEnableGlobs,
    sessionDir,
    hostClaudeDir: hostClaude,
    pluginsCacheDir: pluginsCache,
    pluginsCacheContainerPath: containerCache,
  }).overrideMounts;
}

function patchedAt(mounts: Mount[], dst: string): Record<string, unknown> {
  const m = mounts.find((x) => x.dst === dst);
  expect(m, `no overlay at ${dst}`).toBeDefined();
  expect(m!.mode).toBe("ro");
  return JSON.parse(readFileSync(m!.src, "utf8"));
}

describe("applyPluginPolicy — cache-backed version selection", () => {
  it("overlays the installPath version, not the first cached version by name", () => {
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": true } });
    // Orphaned older version sorts first by name; installed version sorts last.
    writeJSON(join(pluginsCache, "m", "p", "aaa-orphan", ".mcp.json"), {
      mcpServers: { old: { command: "o" } },
    });
    writeJSON(join(pluginsCache, "m", "p", "zzz-active", ".mcp.json"), {
      mcpServers: { srv: { command: "s" } },
    });
    installRecords({ "p@m": [join(pluginsCache, "m", "p", "zzz-active")] });

    const mounts = run();
    const dsts = mounts.map((m) => m.dst).sort();
    expect(dsts).toEqual(
      [
        `${containerCache}/m/p/zzz-active/.mcp.json`,
        join(pluginsCache, "m", "p", "zzz-active", ".mcp.json"),
      ].sort(),
    );
    expect(patchedAt(mounts, join(pluginsCache, "m", "p", "zzz-active", ".mcp.json")).mcpServers).toEqual({});
  });

  it("overlays at both the container-$HOME cache path and the host-absolute install path", () => {
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": true } });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", "hooks", "hooks.json"), hooksFile("node a"));
    installRecords({ "p@m": [join(pluginsCache, "m", "p", "1.0.0")] });

    const mounts = run();
    expect(mounts.map((m) => m.dst).sort()).toEqual(
      [
        `${containerCache}/m/p/1.0.0/hooks/hooks.json`,
        join(pluginsCache, "m", "p", "1.0.0", "hooks", "hooks.json"),
      ].sort(),
    );
    // Both overlays share one filtered copy.
    expect(new Set(mounts.map((m) => m.src)).size).toBe(1);
  });

  it("collapses to one overlay per file when host and container cache paths coincide", () => {
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": true } });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", ".mcp.json"), { mcpServers: {} });
    installRecords({ "p@m": [join(pluginsCache, "m", "p", "1.0.0")] });
    const mounts = applyPluginPolicy({
      hookEnableGlobs: [],
      mcpEnableGlobs: [],
      sessionDir,
      hostClaudeDir: hostClaude,
      pluginsCacheDir: pluginsCache,
      pluginsCacheContainerPath: pluginsCache,
    }).overrideMounts;
    expect(mounts.map((m) => m.dst)).toEqual([join(pluginsCache, "m", "p", "1.0.0", ".mcp.json")]);
  });

  it("covers every scope's installPath for one key", () => {
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": true } });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", ".mcp.json"), { mcpServers: {} });
    writeJSON(join(pluginsCache, "m", "p", "2.0.0", ".mcp.json"), { mcpServers: {} });
    installRecords({
      "p@m": [join(pluginsCache, "m", "p", "1.0.0"), join(pluginsCache, "m", "p", "2.0.0")],
    });
    const dsts = run().map((m) => m.dst);
    expect(dsts).toContain(`${containerCache}/m/p/1.0.0/.mcp.json`);
    expect(dsts).toContain(`${containerCache}/m/p/2.0.0/.mcp.json`);
  });

  it("skips installPath records that leave the cache dir", () => {
    const outside = join(root, "elsewhere", "p");
    writeJSON(join(outside, ".mcp.json"), { mcpServers: { x: { command: "x" } } });
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": true } });
    installRecords({ "p@m": [outside] });
    expect(run()).toEqual([]);
  });

  it("without installed_plugins.json, overlays every cached version (fails closed)", () => {
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": true } });
    writeJSON(join(pluginsCache, "m", "p", "a", ".mcp.json"), { mcpServers: { s: { command: "s" } } });
    writeJSON(join(pluginsCache, "m", "p", "b", ".mcp.json"), { mcpServers: { s: { command: "s" } } });
    const dsts = run().map((m) => m.dst);
    expect(dsts).toContain(`${containerCache}/m/p/a/.mcp.json`);
    expect(dsts).toContain(`${containerCache}/m/p/b/.mcp.json`);
  });

  it("disabled plugins (enabledPlugins[key] !== true) are ignored", () => {
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": false } });
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", "hooks", "hooks.json"), hooksFile("python3 x"));
    installRecords({ "p@m": [join(pluginsCache, "m", "p", "1.0.0")] });
    expect(run(["python3 *"], ["*"])).toEqual([]);
  });
});

describe("applyPluginPolicy — default files", () => {
  const ver = () => join(pluginsCache, "m", "p", "1.0.0");
  beforeEach(() => {
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": true } });
    installRecords({ "p@m": [ver()] });
  });

  it("empty enable lists → hooks {} and mcpServers {}", () => {
    writeJSON(join(ver(), "hooks", "hooks.json"), { description: "keep", ...(hooksFile("node a") as object) });
    writeJSON(join(ver(), ".mcp.json"), { mcpServers: { s: { command: "s" } } });
    const mounts = run();
    const hooks = patchedAt(mounts, join(ver(), "hooks", "hooks.json"));
    expect(hooks.hooks).toEqual({});
    expect(hooks.description).toBe("keep");
    expect(patchedAt(mounts, join(ver(), ".mcp.json")).mcpServers).toEqual({});
  });

  it("globs keep matching hook commands and MCP server names", () => {
    writeJSON(join(ver(), "hooks", "hooks.json"), hooksFile("python3 keep.py", "bash drop.sh"));
    writeJSON(join(ver(), ".mcp.json"), {
      mcpServers: { keep: { command: "k" }, drop: { command: "d" } },
    });
    const mounts = run(["python3 *"], ["keep"]);
    const hooks = patchedAt(mounts, join(ver(), "hooks", "hooks.json")) as {
      hooks: { PreToolUse: { hooks: unknown[] }[] };
    };
    expect(hooks.hooks.PreToolUse[0]!.hooks).toEqual([{ type: "command", command: "python3 keep.py" }]);
    expect(Object.keys(patchedAt(mounts, join(ver(), ".mcp.json")).mcpServers as object)).toEqual(["keep"]);
  });
});

describe("applyPluginPolicy — manifest .claude-plugin/plugin.json", () => {
  const ver = () => join(pluginsCache, "m", "p", "1.0.0");
  const manifestDst = () => join(ver(), ".claude-plugin", "plugin.json");
  beforeEach(() => {
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": true } });
    installRecords({ "p@m": [ver()] });
  });

  it("filters inline hooks and inline mcpServers; other keys survive", () => {
    writeJSON(manifestDst(), {
      name: "p",
      skills: "./skills",
      hooks: (hooksFile("python3 keep.py", "bash drop.sh") as { hooks: unknown }).hooks,
      mcpServers: { keep: { command: "k" }, drop: { command: "d" } },
    });
    const m = patchedAt(run(["python3 *"], ["keep"]), manifestDst()) as {
      name: string;
      skills: string;
      hooks: { PreToolUse: { hooks: unknown[] }[] };
      mcpServers: Record<string, unknown>;
    };
    expect(m.name).toBe("p");
    expect(m.skills).toBe("./skills");
    expect(m.hooks.PreToolUse[0]!.hooks).toEqual([{ type: "command", command: "python3 keep.py" }]);
    expect(Object.keys(m.mcpServers)).toEqual(["keep"]);
  });

  it("keeps a named .json file reference and filters that file", () => {
    writeJSON(manifestDst(), { name: "p", mcpServers: "./mcp.json" });
    writeJSON(join(ver(), "mcp.json"), { mcpServers: { paper: { type: "http", url: "http://x" } } });
    const mounts = run();
    expect(patchedAt(mounts, manifestDst()).mcpServers).toBe("./mcp.json");
    expect(patchedAt(mounts, join(ver(), "mcp.json")).mcpServers).toEqual({});
    expect(patchedAt(mounts, `${containerCache}/m/p/1.0.0/mcp.json`).mcpServers).toEqual({});
  });

  it("filters a named MCP file that holds the bare server map", () => {
    writeJSON(manifestDst(), { name: "p", mcpServers: ["./servers.json"] });
    writeJSON(join(ver(), "servers.json"), { keep: { command: "k" }, drop: { command: "d" } });
    const patched = patchedAt(run([], ["keep"]), join(ver(), "servers.json"));
    expect(Object.keys(patched)).toEqual(["keep"]);
  });

  it("filters a named hooks file", () => {
    writeJSON(manifestDst(), { name: "p", hooks: ["./config/extra.json"] });
    writeJSON(join(ver(), "config", "extra.json"), hooksFile("python3 keep.py", "bash drop.sh"));
    const patched = patchedAt(run(["python3 *"]), join(ver(), "config", "extra.json")) as {
      hooks: { PreToolUse: { hooks: unknown[] }[] };
    };
    expect(patched.hooks.PreToolUse[0]!.hooks).toEqual([{ type: "command", command: "python3 keep.py" }]);
  });

  it("drops .mcpb/.dxt bundles and bundle URLs (scalar → key removed, array → element removed)", () => {
    writeJSON(manifestDst(), { name: "p", mcpServers: "./server.mcpb" });
    writeFileSync(join(ver(), "server.mcpb"), "zip");
    expect("mcpServers" in patchedAt(run(["*"], ["*"]), manifestDst())).toBe(false);

    writeJSON(manifestDst(), {
      name: "p",
      mcpServers: ["https://example.com/s.dxt", { keep: { command: "k" } }],
    });
    expect(patchedAt(run([], ["*"]), manifestDst()).mcpServers).toEqual([{ keep: { command: "k" } }]);
  });

  it("drops references that escape the plugin root or do not exist", () => {
    writeJSON(join(pluginsCache, "m", "p", "outside.json"), { mcpServers: { x: { command: "x" } } });
    writeJSON(manifestDst(), { name: "p", mcpServers: ["../outside.json", "./missing.json"] });
    const mounts = run([], ["*"]);
    expect(patchedAt(mounts, manifestDst()).mcpServers).toEqual([]);
    expect(mounts.some((m) => m.dst.endsWith("outside.json"))).toBe(false);
  });

  it("a manifest naming the default hooks file yields one overlay per path", () => {
    writeJSON(manifestDst(), { name: "p", hooks: "./hooks/hooks.json" });
    writeJSON(join(ver(), "hooks", "hooks.json"), hooksFile("node a"));
    const dsts = run().map((m) => m.dst);
    expect(dsts.length).toBe(new Set(dsts).size);
    expect(dsts).toContain(join(ver(), "hooks", "hooks.json"));
  });

  it("no manifest overlay when the manifest declares neither hooks nor mcpServers", () => {
    writeJSON(manifestDst(), { name: "p", skills: "./skills" });
    expect(run()).toEqual([]);
  });
});

describe("applyPluginPolicy — directory-sourced plugins", () => {
  function setupDirMarket(enabled: boolean): string {
    const marketDir = join(root, "markets", "sb");
    writeJSON(join(marketDir, ".claude-plugin", "marketplace.json"), {
      name: "sb",
      plugins: [{ name: "sb", source: "./" }],
    });
    writeJSON(join(marketDir, "hooks", "hooks.json"), hooksFile("switchboard-hook", "python3 keep.py"));
    writeJSON(join(marketDir, ".mcp.json"), { mcpServers: { grafana: { command: "g" }, other: { command: "o" } } });
    writeJSON(join(hostClaude, "settings.json"), {
      enabledPlugins: { "sb@sb": enabled },
      extraKnownMarketplaces: { sb: { source: { source: "directory", path: marketDir } } },
    });
    return marketDir;
  }

  it("overlays hooks.json and .mcp.json at the plugin host path only", () => {
    const marketDir = setupDirMarket(true);
    const mounts = run(["python3 *"], ["grafana"]);
    expect(mounts.map((m) => m.dst).sort()).toEqual(
      [join(marketDir, "hooks", "hooks.json"), join(marketDir, ".mcp.json")].sort(),
    );
    const hooks = patchedAt(mounts, join(marketDir, "hooks", "hooks.json")) as {
      hooks: { PreToolUse: { hooks: unknown[] }[] };
    };
    expect(hooks.hooks.PreToolUse[0]!.hooks).toEqual([{ type: "command", command: "python3 keep.py" }]);
    expect(Object.keys(patchedAt(mounts, join(marketDir, ".mcp.json")).mcpServers as object)).toEqual([
      "grafana",
    ]);
  });

  it("skipped when the plugin is not enabled", () => {
    setupDirMarket(false);
    expect(run(["*"], ["*"])).toEqual([]);
  });
});

describe("pluginRoots helpers", () => {
  it("classifyManifestField: inline, file, bundle, invalid", () => {
    const r = join(root, "plug");
    writeJSON(join(r, "a.json"), {});
    const out = classifyManifestField(r, ["./a.json", { x: {} }, "./b.mcpb", "../a.json", 7], "mcpServers");
    expect(out.map((e) => e.kind)).toEqual(["file", "inline", "bundle", "invalid", "invalid"]);
    expect(classifyManifestField(r, "./b.mcpb", "hooks")[0]!.kind).toBe("invalid");
  });

  it("resolveComponentPath rejects symlinks that leave the root", () => {
    const r = join(root, "plug");
    writeJSON(join(root, "secret.json"), {});
    mkdirSync(r, { recursive: true });
    symlinkSync(join(root, "secret.json"), join(r, "link.json"));
    expect(resolveComponentPath(r, "./link.json")).toBeNull();
    writeJSON(join(r, "ok.json"), {});
    expect(resolveComponentPath(r, "./ok.json")).toBe("ok.json");
  });

  it("listCachePluginRoots: unreadable installed_plugins.json falls back to every version dir", () => {
    mkdirSync(join(pluginsCache, "m", "p", "1"), { recursive: true });
    mkdirSync(join(pluginsCache, "m", "p", "2"), { recursive: true });
    writeFileSync(join(hostClaude, "plugins", "installed_plugins.json"), "{not json");
    expect(listCachePluginRoots(pluginsCache, "").map((r) => r.version).sort()).toEqual(["1", "2"]);
  });
});

describe("inspect enumeration covers manifest-declared plugin config", () => {
  it("enumerateHooks and enumerateMcpServers read the installed version and the manifest", () => {
    const ver = join(pluginsCache, "m", "p", "2.0.0");
    writeJSON(join(pluginsCache, "m", "p", "1.0.0", ".mcp.json"), { mcpServers: { stale: { command: "s" } } });
    writeJSON(join(ver, ".claude-plugin", "plugin.json"), {
      name: "p",
      hooks: (hooksFile("node inline.js") as { hooks: unknown }).hooks,
      mcpServers: "./mcp.json",
    });
    writeJSON(join(ver, "mcp.json"), { mcpServers: { paper: { type: "http", url: "http://x" } } });
    writeJSON(join(hostClaude, "settings.json"), { enabledPlugins: { "p@m": true } });
    installRecords({ "p@m": [ver] });

    const hooks = enumerateHooks({ hostClaudeDir: hostClaude, pluginsCacheDir: pluginsCache, repos: [] });
    expect(hooks.map((h) => h.command)).toEqual(["node inline.js"]);
    expect(hooks[0]!.plugin).toEqual({ marketplace: "m", plugin: "p", version: "2.0.0" });

    const mcp = enumerateMcpServers({
      hostClaudeDir: hostClaude,
      hostClaudeJsonPath: join(root, "missing.claude.json"),
      pluginsCacheDir: pluginsCache,
      repos: [],
    });
    expect(mcp.map((r) => r.name)).toEqual(["paper"]);
    expect(mcp[0]!.sourcePath).toBe(join(ver, "mcp.json"));
  });
});
