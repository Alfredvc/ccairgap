import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { LayeredResult } from "./configLayered.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(tmpdir() + "/ccairgap-inspect-test-"));
  // Point claude config to an existing temp dir so inspectCmd's realpath() succeeds.
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  vi.restoreAllMocks();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("inspectCmd JSON output", () => {
  it("includes config.merged and config.provenance when config is provided", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const layered: LayeredResult = {
      merged: { name: "my-session", dockerRunArg: ["--network=none"] },
      provenance: {
        name: "user-wide",
        dockerRunArg: ["user-wide", "project"],
      },
    };

    const { inspectCmd } = await import("./subcommands.js");
    inspectCmd({ repos: [], pretty: false, config: layered });

    const calls = logSpy.mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    const output = calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(parsed).toHaveProperty("hooks");
    expect(parsed).toHaveProperty("mcpServers");
    expect(parsed).toHaveProperty("env");
    expect(parsed).toHaveProperty("marketplaces");
    expect(parsed).toHaveProperty("config");

    const cfg = parsed.config as { merged: unknown; provenance: unknown };
    expect(cfg.merged).toEqual({ name: "my-session", dockerRunArg: ["--network=none"] });
    expect(cfg.provenance).toEqual({
      name: "user-wide",
      dockerRunArg: ["user-wide", "project"],
    });
  });

  it("omits config field from JSON when config is not provided", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { inspectCmd } = await import("./subcommands.js");
    inspectCmd({ repos: [], pretty: false });

    const output = logSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(output) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty("config");
  });
});

describe("formatInspectPretty config section", () => {
  it("includes RESOLVED CONFIG section when config is provided", async () => {
    const { formatInspectPretty } = await import("./inspectFormat.js");
    const layered: LayeredResult = {
      merged: { name: "my-session" },
      provenance: { name: "project" },
    };
    const output = formatInspectPretty({
      hooks: [],
      mcpServers: [],
      env: [],
      marketplaces: [],
      config: layered,
    });
    expect(output).toContain("RESOLVED CONFIG");
    expect(output).toContain("name");
    expect(output).toContain("my-session");
    expect(output).toContain("project");
  });

  it("omits RESOLVED CONFIG section when config is not provided", async () => {
    const { formatInspectPretty } = await import("./inspectFormat.js");
    const output = formatInspectPretty({
      hooks: [],
      mcpServers: [],
      env: [],
      marketplaces: [],
    });
    expect(output).not.toContain("RESOLVED CONFIG");
  });

  it("renders array values as comma-separated and array provenance as comma-separated", async () => {
    const { formatInspectPretty } = await import("./inspectFormat.js");
    const layered: LayeredResult = {
      merged: { dockerRunArg: ["--network=none", "--memory=2g"] },
      provenance: { dockerRunArg: ["user-wide", "project"] },
    };
    const output = formatInspectPretty({
      hooks: [],
      mcpServers: [],
      env: [],
      marketplaces: [],
      config: layered,
    });
    expect(output).toContain("--network=none, --memory=2g");
    expect(output).toContain("user-wide, project");
  });

  it("shows correct provenance (not 'undefined') for hooks and mcp rows", async () => {
    // mergeLayers stores provenance under the dotted keys "hooks.enable" and
    // "mcp.enable", but the merged object has top-level "hooks" / "mcp" keys.
    // renderConfig must bridge that gap; this is the regression guard.
    const { formatInspectPretty } = await import("./inspectFormat.js");
    const layered: LayeredResult = {
      merged: {
        hooks: { enable: ["my-hook"] },
        mcp: { enable: ["my-server"] },
      },
      provenance: {
        "hooks.enable": ["project"],
        "mcp.enable": ["user-wide", "project"],
      },
    };
    const output = formatInspectPretty({
      hooks: [],
      mcpServers: [],
      env: [],
      marketplaces: [],
      config: layered,
    });
    expect(output).toContain("RESOLVED CONFIG");
    // provenance columns must NOT show the string "undefined"
    expect(output).not.toContain("undefined");
    // hooks row should show the project source
    expect(output).toContain("project");
    // mcp row should show both sources
    expect(output).toContain("user-wide, project");
  });

  it("renders plain object values as K=V per line (not JSON) in RESOLVED CONFIG", async () => {
    // Regression: dockerBuildArg (and other map-valued config keys) used to be
    // formatted via JSON.stringify, producing {"FOO":"1","BAR":"2"} which then
    // hard-cut at 60 chars with no clean break point. The new format renders one
    // KEY=VALUE entry per line so wrapCell preserves each entry intact.
    const { formatInspectPretty } = await import("./inspectFormat.js");
    const layered: LayeredResult = {
      merged: { dockerBuildArg: { FOO: "1", BAR: "2" } },
      provenance: { dockerBuildArg: "project" },
    };
    const output = formatInspectPretty({
      hooks: [],
      mcpServers: [],
      env: [],
      marketplaces: [],
      config: layered,
    });
    expect(output).toContain("RESOLVED CONFIG");
    expect(output).toContain("FOO=1");
    expect(output).toContain("BAR=2");
    // Must NOT fall back to JSON format
    expect(output).not.toContain('{"FOO"');
  });
});
