import { parse, stringify } from "smol-toml";

export interface CodexPolicyWarning {
  code: string;
  message: string;
  source?: string;
}

export interface CodexConfigPolicyResult {
  content?: string;
  warnings: CodexPolicyWarning[];
}

const DANGEROUS_TOP_LEVEL_KEYS = [
  "openai_base_url",
  "chatgpt_base_url",
  "model_provider",
  "model_providers",
  "profile",
  "profiles",
  "experimental_realtime_ws_base_url",
  "otel",
  "notify",
  "plugins",
  "plugin_marketplaces",
  "marketplaces",
  "codex_apps",
  "mcp_oauth_credentials_store",
  "provider_auth_command",
  "auth_command",
  "apps",
] as const;

function matchesGlob(value: string, patterns: readonly string[] = []): boolean {
  return patterns.some((pattern) => {
    if (pattern === value || pattern === "*") return true;
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`^${escaped}$`).test(value);
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stripKeys(doc: Record<string, unknown>, warnings: CodexPolicyWarning[], source?: string) {
  for (const key of DANGEROUS_TOP_LEVEL_KEYS) {
    if (key in doc) {
      delete doc[key];
      warnings.push({
        code: "stripped-codex-config-key",
        message: `removed Codex config key '${key}'`,
        source,
      });
    }
  }
}

function filterMcpServers(
  doc: Record<string, unknown>,
  enabled: readonly string[],
  warnings: CodexPolicyWarning[],
  source?: string,
) {
  const servers = asRecord(doc.mcp_servers);
  if (!servers) return;
  const kept: Record<string, unknown> = {};
  for (const [name, server] of Object.entries(servers)) {
    if (matchesGlob(name, enabled)) kept[name] = server;
    else {
      warnings.push({
        code: "disabled-codex-mcp",
        message: `disabled Codex MCP server '${name}'`,
        source,
      });
    }
  }
  if (Object.keys(kept).length > 0) doc.mcp_servers = kept;
  else delete doc.mcp_servers;
}

function hookCommand(value: unknown): string | undefined {
  const rec = asRecord(value);
  if (!rec) return typeof value === "string" ? value : undefined;
  const cmd = rec.command ?? rec.cmd;
  return typeof cmd === "string" ? cmd : undefined;
}

function filterHookRecord(
  hooks: Record<string, unknown>,
  enabled: readonly string[],
  warnings: CodexPolicyWarning[],
  source?: string,
): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [name, hookValue] of Object.entries(hooks)) {
    const command = hookCommand(hookValue);
    if (command && matchesGlob(command, enabled)) kept[name] = hookValue;
    else {
      warnings.push({
        code: "disabled-codex-hook",
        message: `disabled Codex hook '${name}'`,
        source,
      });
    }
  }
  return kept;
}

export function filterCodexConfigToml(options: {
  toml: string;
  source?: string;
  mcpEnable?: readonly string[];
  hookEnable?: readonly string[];
}): CodexConfigPolicyResult {
  const warnings: CodexPolicyWarning[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = parse(options.toml) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`Codex config TOML parse failed: ${(e as Error).message}`);
  }

  stripKeys(doc, warnings, options.source);
  doc.cli_auth_credentials_store = "file";

  filterMcpServers(doc, options.mcpEnable ?? [], warnings, options.source);

  const hooks = asRecord(doc.hooks);
  if (hooks) {
    const kept = filterHookRecord(hooks, options.hookEnable ?? [], warnings, options.source);
    if (Object.keys(kept).length > 0) {
      doc.hooks = kept;
      const features = asRecord(doc.features) ?? {};
      features.codex_hooks = true;
      doc.features = features;
    } else {
      delete doc.hooks;
      const features = asRecord(doc.features);
      if (features) features.codex_hooks = false;
    }
  }

  return { content: stringify(doc), warnings };
}

export function filterProjectCodexConfigToml(options: {
  toml: string;
  source?: string;
  mcpEnable?: readonly string[];
  hookEnable?: readonly string[];
}): CodexConfigPolicyResult {
  return filterCodexConfigToml(options);
}

function filterHookJsonValue(
  value: unknown,
  enabled: readonly string[],
  warnings: CodexPolicyWarning[],
  source?: string,
): unknown {
  if (Array.isArray(value)) {
    const kept = value.filter((entry, index) => {
      const command = hookCommand(entry);
      const keep = !!command && matchesGlob(command, enabled);
      if (!keep) {
        warnings.push({
          code: "disabled-codex-hook",
          message: `disabled Codex hook at index ${index}`,
          source,
        });
      }
      return keep;
    });
    return kept.length > 0 ? kept : undefined;
  }
  const hooks = asRecord(value);
  if (!hooks) return undefined;
  const kept = filterHookRecord(hooks, enabled, warnings, source);
  return Object.keys(kept).length > 0 ? kept : undefined;
}

export function filterCodexHooksJson(options: {
  json: string;
  source?: string;
  hookEnable?: readonly string[];
}): CodexConfigPolicyResult {
  const warnings: CodexPolicyWarning[] = [];
  const parsed = JSON.parse(options.json) as unknown;
  const filtered = filterHookJsonValue(
    parsed,
    options.hookEnable ?? [],
    warnings,
    options.source,
  );
  return {
    content: filtered === undefined ? undefined : JSON.stringify(filtered, null, 2) + "\n",
    warnings,
  };
}

export function filterProjectCodexHooksJson(options: {
  json: string;
  source?: string;
  hookEnable?: readonly string[];
}): CodexConfigPolicyResult {
  return filterCodexHooksJson(options);
}

export function omitCodexRules(source?: string): CodexPolicyWarning {
  return {
    code: "omitted-codex-rules",
    message: "Codex execpolicy rules are omitted in ccairgap-managed sessions",
    source,
  };
}

export function assertNoManagedRequirementsInputs(paths: string[]): void {
  if (paths.length > 0) {
    throw new Error(
      `Codex managed/cloud requirement inputs are not supported: ${paths.join(", ")}`,
    );
  }
}

export function assertNoLegacyManagedHooksInputs(paths: string[]): void {
  if (paths.length > 0) {
    throw new Error(`Codex legacy managed hooks are not supported: ${paths.join(", ")}`);
  }
}
