import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LayeredResult } from "./configLayered.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = realpathSync(mkdtempSync(tmpdir() + "/ccairgap-inspect-test-"));
  // Point claude config to an existing temp dir so inspectCmd's realpath() succeeds.
  process.env.CLAUDE_CONFIG_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
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

  it("reports Codex sanitized state without printing auth secrets", async () => {
    const codexHome = realpathSync(mkdtempSync(tmpdir() + "/ccairgap-codex-inspect-"));
    process.env.CODEX_HOME = codexHome;
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        'model = "gpt-5"',
        'openai_base_url = "https://secret.example"',
        "[mcp_servers.secret]",
        'command = "printenv"',
        "",
      ].join("\n"),
    );
    writeFileSync(codexHome + "/auth.json", JSON.stringify({ OPENAI_API_KEY: "sk-secret" }));
    mkdirSync(join(codexHome, "sessions", "2026", "05", "13"), { recursive: true });
    writeFileSync(
      join(codexHome, "sessions", "2026", "05", "13", "rollout-test.jsonl"),
      "{}\n",
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const { inspectCmd } = await import("./subcommands.js");
    inspectCmd({ repos: [], pretty: false, agent: "codex" });

    const output = logSpy.mock.calls[0]?.[0] as string;
    expect(output).toContain("disabled Codex MCP server");
    expect(output).not.toContain("sk-secret");
    expect(output).not.toContain("https://secret.example");
    const parsed = JSON.parse(output) as { codex?: { auth?: { present?: boolean; kind?: string }; sessions?: { rolloutFiles?: number } } };
    expect(parsed.codex?.auth?.present).toBe(true);
    expect(parsed.codex?.auth?.kind).toBe("api-key");
    expect(parsed.codex?.sessions?.rolloutFiles).toBe(1);
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

  it("renders Codex inspect state without secrets", async () => {
    const { formatInspectPretty } = await import("./inspectFormat.js");
    const output = formatInspectPretty({
      hooks: [],
      mcpServers: [],
      env: [],
      marketplaces: [],
      codex: {
        hostHome: "/tmp/codex",
        config: {
          present: true,
          sanitized: 'cli_auth_credentials_store = "file"\n',
          warnings: [{ code: "x", message: "removed Codex config key", source: "/tmp/codex/config.toml" }],
        },
        hooks: {
          present: true,
          sanitized: "{}\n",
          warnings: [{ code: "hook", message: "disabled Codex hook", source: "/tmp/codex/hooks.json" }],
        },
        auth: { present: true, ok: true, kind: "api-key", warnings: [] },
        sessions: { present: true, rolloutFiles: 2 },
        warnings: [],
      },
    });
    expect(output).toContain("CODEX");
    expect(output).toContain("api-key");
    expect(output).toContain("disabled Codex hook");
    expect(output).toContain("rolloutFiles=2");
    expect(output).not.toContain("OPENAI_API_KEY");
  });
});
