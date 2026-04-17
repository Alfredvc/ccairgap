import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  isPluginEnabled,
  listDirectoryPlugins,
  listPluginsOnDisk,
  readJsonOrNull,
} from "./hooks.js";
import { realpath } from "./paths.js";

/**
 * Read-only enumeration of MCP server definitions the container would pick up at launch.
 * Mirrors `enumerateHooks` in `src/hooks.ts`. Used by the `inspect` subcommand so
 * users / skills can see the full MCP surface without hand-walking config files.
 *
 * Sources (per Claude Code docs, https://code.claude.com/docs/en/mcp):
 * - `user`          — `~/.claude.json` top-level `mcpServers` (user scope, cross-project).
 * - `user-project`  — `~/.claude.json` `projects["<abs-path>"].mcpServers` (local scope,
 *                     per-project-private). Attributed to the repo whose `hostPath`
 *                     resolves to the same absolute path.
 * - `project`       — `<repo>/.mcp.json` `mcpServers` (project scope, shared/committed).
 *                     Carries `approvalState` derived from approval config.
 * - `plugin`        — `<plugin-root>/.mcp.json` `mcpServers` AND
 *                     `<plugin-root>/plugin.json` `mcpServers` (inline). Only emitted
 *                     when the plugin is `enabledPlugins["<plugin>@<market>"] === true`.
 *                     Covers BOTH cache-backed plugins (under `~/.claude/plugins/cache/`)
 *                     AND directory-sourced marketplace plugins (from
 *                     `extraKnownMarketplaces[*].source.source === "directory"`, whose
 *                     plugin roots live outside the cache and mount into the container
 *                     1:1 via `discoverLocalMarketplaces`).
 *
 * Managed MCP scope (/Library/Application Support/ClaudeCode/managed-mcp.json and peers)
 * is intentionally omitted — those paths are not mounted into the container.
 */
export type McpSource = "user" | "user-project" | "project" | "plugin";

/** Tri-state for project `.mcp.json` servers (they require user approval before use). */
export type McpApprovalState = "approved" | "denied" | "unapproved";

export interface McpRecord {
  source: McpSource;
  sourcePath: string;
  name: string;
  /** Raw server definition as written — `command`, `args`, `env`, `url`, `type`, `headers`, ... */
  definition: Record<string, unknown>;
  /** `plugin` source only. */
  plugin?: { marketplace: string; plugin: string; version: string };
  /** `user-project` source: repo basename whose hostPath matched the project key.
   *  `project` source: repo basename the `.mcp.json` was read from. */
  repo?: string;
  /** `user-project` source: absolute project-key path under `~/.claude.json` `projects`. */
  projectPath?: string;
  /** `project` source only: effective approval state from enabled/disabled/enableAll flags. */
  approvalState?: McpApprovalState;
}

export interface EnumerateMcpInput {
  hostClaudeDir: string;
  /** Path to host `~/.claude.json`. */
  hostClaudeJsonPath: string;
  pluginsCacheDir: string;
  repos: { basename: string; hostPath: string }[];
}

/** Safely resolve a path through realpath, returning the raw path on failure. */
function tryRealpath(p: string): string {
  try {
    return realpath(p);
  } catch {
    return p;
  }
}

/** Pull string-array fields from an object; tolerant of wrong shapes. */
function stringArray(val: unknown): string[] {
  if (!Array.isArray(val)) return [];
  return val.filter((v): v is string => typeof v === "string");
}

/** Pull a boolean flag, defaulting to false on wrong shape. */
function boolFlag(val: unknown): boolean {
  return val === true;
}

/**
 * Derive approval state for a project-scope `.mcp.json` server by merging the
 * approval lists across every surface that affects it:
 * - user `~/.claude/settings.json`
 * - project `<repo>/.claude/settings.json` and `settings.local.json`
 * - `~/.claude.json` `projects[<repo-path>]` (Claude CLI writes approvals here)
 *
 * Precedence: any scope denying wins; then any scope approving (allowlist or
 * `enableAllProjectMcpServers`) wins; otherwise `unapproved`. This reflects how
 * Claude Code treats a missing approval as "will prompt" — which in a non-interactive
 * airgap session means the server won't start.
 */
function deriveApproval(
  serverName: string,
  scopes: Array<Record<string, unknown> | null | undefined>,
): McpApprovalState {
  let anyEnabled = false;
  for (const s of scopes) {
    if (!s) continue;
    if (stringArray(s.disabledMcpjsonServers).includes(serverName)) return "denied";
    if (stringArray(s.enabledMcpjsonServers).includes(serverName)) anyEnabled = true;
    if (boolFlag(s.enableAllProjectMcpServers)) anyEnabled = true;
  }
  return anyEnabled ? "approved" : "unapproved";
}

/** Emit one McpRecord per entry in a raw `mcpServers` object, with shared attribution. */
function collectMcpServers(
  mcpServers: unknown,
  base: Omit<McpRecord, "name" | "definition">,
  out: McpRecord[],
): void {
  if (!mcpServers || typeof mcpServers !== "object" || Array.isArray(mcpServers)) return;
  for (const [name, defRaw] of Object.entries(mcpServers as Record<string, unknown>)) {
    if (!defRaw || typeof defRaw !== "object" || Array.isArray(defRaw)) continue;
    out.push({ ...base, name, definition: defRaw as Record<string, unknown> });
  }
}

export function enumerateMcpServers(input: EnumerateMcpInput): McpRecord[] {
  const { hostClaudeDir, hostClaudeJsonPath, pluginsCacheDir, repos } = input;
  const out: McpRecord[] = [];

  const claudeJson = readJsonOrNull(hostClaudeJsonPath) as Record<string, unknown> | null;
  const userSettings = readJsonOrNull(join(hostClaudeDir, "settings.json")) as
    | Record<string, unknown>
    | null;

  // 1. user scope: ~/.claude.json top-level mcpServers.
  if (claudeJson) {
    collectMcpServers(
      claudeJson.mcpServers,
      { source: "user", sourcePath: hostClaudeJsonPath },
      out,
    );
  }

  // 2. user-project scope: ~/.claude.json projects["<abs-path>"].mcpServers.
  //    Attribute to a repo by matching realpaths.
  const projects =
    claudeJson && typeof claudeJson.projects === "object" && claudeJson.projects !== null
      ? (claudeJson.projects as Record<string, unknown>)
      : {};
  const repoByRealpath = new Map<string, string>();
  for (const r of repos) repoByRealpath.set(tryRealpath(r.hostPath), r.basename);
  for (const [projPath, entry] of Object.entries(projects)) {
    if (!entry || typeof entry !== "object") continue;
    const mcpServers = (entry as { mcpServers?: unknown }).mcpServers;
    if (!mcpServers) continue;
    const matchedRepo = repoByRealpath.get(tryRealpath(projPath));
    collectMcpServers(
      mcpServers,
      {
        source: "user-project",
        sourcePath: hostClaudeJsonPath,
        projectPath: projPath,
        repo: matchedRepo,
      },
      out,
    );
  }

  // 3. project scope: <repo>/.mcp.json. Enabled state derived from approval config.
  for (const r of repos) {
    const mcpPath = join(r.hostPath, ".mcp.json");
    const raw = readJsonOrNull(mcpPath) as Record<string, unknown> | null;
    if (!raw) continue;
    const servers = raw.mcpServers;
    if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;

    const projSettings = readJsonOrNull(join(r.hostPath, ".claude", "settings.json")) as
      | Record<string, unknown>
      | null;
    const projLocal = readJsonOrNull(join(r.hostPath, ".claude", "settings.local.json")) as
      | Record<string, unknown>
      | null;
    const claudeJsonProjectEntry =
      claudeJson && (() => {
        const projs = claudeJson.projects;
        if (!projs || typeof projs !== "object") return null;
        const realRepo = tryRealpath(r.hostPath);
        for (const [k, v] of Object.entries(projs as Record<string, unknown>)) {
          if (tryRealpath(k) === realRepo && v && typeof v === "object") {
            return v as Record<string, unknown>;
          }
        }
        return null;
      })();
    const scopes = [userSettings, projSettings, projLocal, claudeJsonProjectEntry];

    for (const [name, defRaw] of Object.entries(servers as Record<string, unknown>)) {
      if (!defRaw || typeof defRaw !== "object" || Array.isArray(defRaw)) continue;
      out.push({
        source: "project",
        sourcePath: mcpPath,
        name,
        definition: defRaw as Record<string, unknown>,
        repo: r.basename,
        approvalState: deriveApproval(name, scopes),
      });
    }
  }

  // 4. plugin scope: enabled-plugin .mcp.json and plugin.json#mcpServers.
  const enabledPlugins = userSettings?.enabledPlugins;

  function collectPluginMcp(
    hostDir: string,
    pluginAttr: { marketplace: string; plugin: string; version: string },
  ): void {
    const mcpJsonPath = join(hostDir, ".mcp.json");
    if (existsSync(mcpJsonPath)) {
      const raw = readJsonOrNull(mcpJsonPath) as Record<string, unknown> | null;
      if (raw) {
        collectMcpServers(
          raw.mcpServers,
          { source: "plugin", sourcePath: mcpJsonPath, plugin: pluginAttr },
          out,
        );
      }
    }
    const pluginJsonPath = join(hostDir, "plugin.json");
    if (existsSync(pluginJsonPath)) {
      const raw = readJsonOrNull(pluginJsonPath) as Record<string, unknown> | null;
      if (raw) {
        collectMcpServers(
          raw.mcpServers,
          { source: "plugin", sourcePath: pluginJsonPath, plugin: pluginAttr },
          out,
        );
      }
    }
  }

  // Cache-backed plugins (containerCacheDir unused for enumeration; pass empty string).
  for (const p of listPluginsOnDisk(pluginsCacheDir, "")) {
    if (!isPluginEnabled(enabledPlugins, p.key)) continue;
    collectPluginMcp(p.hostDir, {
      marketplace: p.marketplace,
      plugin: p.plugin,
      version: p.version,
    });
  }

  // Directory-sourced plugins: loaded from the marketplace source tree (1:1 RO-mounted
  // by `discoverLocalMarketplaces`), not from the cache. Without this branch, MCP
  // servers declared in such plugins are invisible to `inspect` even though they run.
  for (const dp of listDirectoryPlugins(hostClaudeDir)) {
    if (!isPluginEnabled(enabledPlugins, dp.key)) continue;
    collectPluginMcp(dp.hostDir, {
      marketplace: dp.marketplace,
      plugin: dp.plugin,
      version: "directory",
    });
  }

  return out;
}
