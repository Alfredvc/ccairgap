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
    expect((parsed.features as Record<string, unknown>).codex_hooks).toBe(true);
    expect(result.warnings.map((w) => w.code)).toContain("stripped-codex-config-key");
  });

  it("disables MCP and hooks by default", () => {
    const result = filterCodexConfigToml({
      toml: `
[mcp_servers.filesystem]
command = "node"

[hooks.pre_model]
command = "echo blocked"
`,
    });
    const parsed = parse(result.content ?? "") as Record<string, unknown>;
    expect(parsed.mcp_servers).toBeUndefined();
    expect(parsed.hooks).toBeUndefined();
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
