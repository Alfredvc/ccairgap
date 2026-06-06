import { describe, expect, it } from "vitest";
import { parse } from "smol-toml";
import {
  assertNoLegacyManagedHooksInputs,
  assertNoManagedRequirementsInputs,
  filterCodexConfigToml,
  filterCodexHooksJson,
  omitCodexRules,
} from "./codexConfigPolicy.js";

describe("filterCodexConfigToml", () => {
  it("forces file auth, preserves unknown safe keys, and strips automation/credential routing", () => {
    const result = filterCodexConfigToml({
      toml: `
safe_key = "kept"
cli_auth_credentials_store = "keyring"
openai_base_url = "https://example.invalid"
model_provider = "custom"
notify = ["run"]
otel = { exporter = "otlp" }
codex_apps = ["app"]

[model_providers.custom]
base_url = "https://models.invalid"
auth_command = "secret"

[mcp_servers.filesystem]
command = "node"

[mcp_servers.safe]
command = "local"

[hooks.pre_model]
command = "echo blocked"

[hooks.keep]
command = "safe-hook"

[features]
codex_hooks = false
`,
      mcpEnable: ["safe"],
      hookEnable: ["safe-*"],
    });

    const parsed = parse(result.content ?? "") as Record<string, unknown>;
    expect(parsed.safe_key).toBe("kept");
    expect(parsed.cli_auth_credentials_store).toBe("file");
    expect(parsed.openai_base_url).toBeUndefined();
    expect(parsed.model_providers).toBeUndefined();
    expect(parsed.notify).toBeUndefined();
    expect(parsed.codex_apps).toBeUndefined();
    expect(Object.keys(parsed.mcp_servers as Record<string, unknown>)).toEqual(["safe"]);
    expect(Object.keys(parsed.hooks as Record<string, unknown>)).toEqual(["keep"]);
    expect((parsed.features as Record<string, unknown>).hooks).toBe(true);
    expect((parsed.features as Record<string, unknown>).codex_hooks).toBeUndefined();
    expect(result.content).not.toContain("codex_hooks");
    expect(result.warnings.map((w) => w.code)).toContain("stripped-codex-config-key");
  });

  it("preserves plugin and marketplace config while stripping command/auth routing surfaces", () => {
    const result = filterCodexConfigToml({
      toml: `
notify = ["notify-send", "Codex"]
plugin_marketplaces = { old = "shape" }

[plugins."sample@debug"]
enabled = true

[plugins."sample@debug".mcp_servers.sample]
enabled = true

[marketplaces.debug]
source_type = "local"
source = "/Users/me/debug-marketplace"
`,
    });

    const parsed = parse(result.content ?? "") as Record<string, unknown>;
    const plugins = parsed.plugins as Record<string, unknown>;
    const marketplaces = parsed.marketplaces as Record<string, unknown>;
    expect(Object.keys(plugins)).toEqual(["sample@debug"]);
    expect(Object.keys(marketplaces)).toEqual(["debug"]);
    expect(parsed.notify).toBeUndefined();
    expect(parsed.plugin_marketplaces).toBeUndefined();
    expect(result.warnings.map((w) => w.message)).not.toContain(
      "removed Codex config key 'plugins'",
    );
    expect(result.warnings.map((w) => w.message)).not.toContain(
      "removed Codex config key 'marketplaces'",
    );
    expect(result.warnings.map((w) => w.message)).toContain(
      "removed Codex config key 'notify'",
    );
  });

  it("filters current event-array TOML hooks by command and does not treat hook state as a hook", () => {
    const result = filterCodexConfigToml({
      toml: `
[features]
hooks = true

[hooks.state."config.toml:pre_tool_use:0:0"]
enabled = true
trusted_hash = "sha256:abc"

[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "allowed-hook"

[[hooks.PostToolUse]]
matcher = "Bash"

[[hooks.PostToolUse.hooks]]
type = "command"
command = "blocked-hook"
`,
      hookEnable: ["allowed-*"],
    });

    const parsed = parse(result.content ?? "") as Record<string, unknown>;
    const hooks = parsed.hooks as Record<string, unknown>;
    expect(hooks).toBeDefined();
    expect((hooks.PreToolUse as unknown[]).length).toBe(1);
    expect(hooks.PostToolUse).toBeUndefined();
    expect(hooks.state).toBeDefined();
    expect((parsed.features as Record<string, unknown>).hooks).toBe(true);
    expect(result.warnings.map((w) => w.message)).not.toContain(
      "disabled Codex hook 'state'",
    );
    expect(result.warnings.map((w) => w.message)).not.toContain(
      "disabled Codex hook 'PostToolUse'",
    );
    expect(result.warnings.map((w) => w.message)).toContain(
      "disabled Codex hook command 'blocked-hook'",
    );
  });

  it("removes the hooks feature flag when no hook commands are kept", () => {
    const result = filterCodexConfigToml({
      toml: `
[features]
hooks = true
web_search_request = true

[[hooks.PreToolUse]]
matcher = "Bash"

[[hooks.PreToolUse.hooks]]
type = "command"
command = "blocked-hook"
`,
      hookEnable: [],
    });

    const parsed = parse(result.content ?? "") as Record<string, unknown>;
    expect(parsed.hooks).toBeUndefined();
    expect((parsed.features as Record<string, unknown>).hooks).toBeUndefined();
    expect((parsed.features as Record<string, unknown>).web_search_request).toBe(true);
  });

  it("disables MCP and hooks by default without preserving deprecated hook flags", () => {
    const result = filterCodexConfigToml({
      toml: `
[mcp_servers.filesystem]
command = "node"

[hooks.pre_model]
command = "echo blocked"

[features]
codex_hooks = true
`,
    });
    const parsed = parse(result.content ?? "") as Record<string, unknown>;
    expect(parsed.mcp_servers).toBeUndefined();
    expect(parsed.hooks).toBeUndefined();
    expect(parsed.features).toBeUndefined();
    expect(result.content).not.toContain("codex_hooks");
  });
});

describe("filterCodexHooksJson", () => {
  it("keeps only command matches and omits empty hook files", () => {
    const kept = filterCodexHooksJson({
      hookEnable: ["allowed-*"],
      json: JSON.stringify({
        a: { command: "blocked" },
        b: { command: "allowed-hook" },
      }),
    });
    expect(JSON.parse(kept.content ?? "{}")).toEqual({ b: { command: "allowed-hook" } });

    const omitted = filterCodexHooksJson({
      hookEnable: ["nope"],
      json: JSON.stringify([{ command: "blocked" }]),
    });
    expect(omitted.content).toBeUndefined();
  });

  it("filters the current hooks.json wrapper shape", () => {
    const kept = filterCodexHooksJson({
      hookEnable: ["allowed-*"],
      json: JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [
                { type: "command", command: "blocked-hook" },
                { type: "command", command: "allowed-hook" },
              ],
            },
          ],
        },
      }),
    });

    expect(JSON.parse(kept.content ?? "{}")).toEqual({
      hooks: {
        PostToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "allowed-hook" }],
          },
        ],
      },
    });
    expect(kept.warnings.map((w) => w.message)).toContain(
      "disabled Codex hook command 'blocked-hook'",
    );
  });
});

describe("managed/rule policy helpers", () => {
  it("fails closed for managed requirement and legacy managed hook sources", () => {
    expect(() => assertNoManagedRequirementsInputs(["/etc/codex/config.toml"])).toThrow(
      /managed/,
    );
    expect(() => assertNoLegacyManagedHooksInputs(["managed-hooks.json"])).toThrow(
      /managed hooks/,
    );
    expect(omitCodexRules(".codex/rules").code).toBe("omitted-codex-rules");
  });
});
