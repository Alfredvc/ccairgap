import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  isPluginEnabled,
  listDirectoryPlugins,
  listPluginsOnDisk,
  matchesEnable,
  readJsonOrNull,
} from "./hooks.js";
import type { Mount } from "./mounts.js";
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

/**
 * MCP policy: default is "all MCP servers off". Users opt-in specific servers
 * by a glob matched against the server `name` (key under `mcpServers`). Claude
 * Code has no native per-server disable, so we filter MCP JSON at four sources
 * (user `~/.claude.json` top-level, user-project `~/.claude.json` projects[*],
 * project `<repo>/.mcp.json`, enabled plugin `.mcp.json` + `plugin.json`) and
 * deliver the patched files as nested bind mounts (single-file overlays).
 *
 * Project-scope `<repo>/.mcp.json` is additionally gated by the host approval
 * state (`enabledMcpjsonServers` / `enableAllProjectMcpServers` / absence of a
 * `disabledMcpjsonServers` entry). A server that was never approved on the
 * host is stripped even if the glob matches — the approval dialog is
 * unreachable inside the airgap container, so "was it approved on host?" is
 * the only trust signal available. User-scope and plugin-scope have no such
 * gate (user put it there / enabled the plugin themselves).
 */
export interface McpPolicy {
  enableGlobs: string[];
}

export interface McpPolicyRepo {
  basename: string;
  sessionClonePath: string;
  hostPath: string;
  /** Unique per-repo segment for policy scratch dirs. Produced by `alternatesName()`. */
  alternatesName: string;
}

export interface ApplyMcpPolicyInput {
  policy: McpPolicy;
  sessionDir: string;
  /** Host ~/.claude/ (resolved). Read: settings.json (for approval scopes + enabledPlugins). */
  hostClaudeDir: string;
  /** Host path of `~/.claude.json`. Filtered and overlaid at `/host-claude-patched-json`. */
  hostClaudeJsonPath: string;
  /** Host plugins cache. Read: each plugin's `.mcp.json` / `plugin.json`. */
  pluginsCacheDir: string;
  /** Container path where the plugins cache mounts. Used to build nested override mount dsts. */
  pluginsCacheContainerPath: string;
  /** Session clones; used to find project `.mcp.json` (in the clone) and build override mount dsts at the container-facing repo path. */
  repos: McpPolicyRepo[];
}

export interface ApplyMcpPolicyResult {
  /**
   * Host path of the patched `~/.claude.json` with user-scope and every
   * user-project-scope `mcpServers` filtered. Always produced — empty enable
   * list yields `mcpServers: {}` at every scope. Mounted RO at
   * `/host-claude-patched-json`; entrypoint overlays it on the rsync'd copy
   * before the jq onboarding patch.
   */
  patchedClaudeJsonPath: string;
  /**
   * Nested single-file bind mounts (RO):
   * - plugin `.mcp.json` + `plugin.json` overrides (cache-backed and directory-sourced)
   * - per-repo `<repo>/.mcp.json` overrides
   * One entry per MCP-bearing source that exists on disk. With empty globs
   * every `mcpServers` field is `{}`; with a non-empty list it's filtered
   * down to surviving entries (and project-scope further to approved ones).
   */
  overrideMounts: Mount[];
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o644 });
}

/**
 * Filter an `mcpServers` object, keeping only entries whose name matches one
 * of the globs. If `approvedSet` is provided (project scope), the name must
 * ALSO be in the set. Returns a new object.
 */
function filterMcpServers(
  servers: unknown,
  globs: string[],
  approvedSet?: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return out;
  for (const [name, def] of Object.entries(servers as Record<string, unknown>)) {
    if (!def || typeof def !== "object" || Array.isArray(def)) continue;
    if (!matchesEnable(name, globs)) continue;
    if (approvedSet && !approvedSet.has(name)) continue;
    out[name] = def;
  }
  return out;
}

export function applyMcpPolicy(input: ApplyMcpPolicyInput): ApplyMcpPolicyResult {
  const {
    policy,
    sessionDir,
    hostClaudeDir,
    hostClaudeJsonPath,
    pluginsCacheDir,
    pluginsCacheContainerPath,
    repos,
  } = input;
  const globs = policy.enableGlobs;
  const policyDir = join(sessionDir, "mcp-policy");

  // 1) Patch `~/.claude.json`: user-scope + every user-project-scope `mcpServers`.
  const claudeJsonRaw = (readJsonOrNull(hostClaudeJsonPath) ?? {}) as Record<
    string,
    unknown
  >;
  const patchedClaudeJson: Record<string, unknown> = { ...claudeJsonRaw };
  patchedClaudeJson.mcpServers = filterMcpServers(claudeJsonRaw.mcpServers, globs);
  const projects = claudeJsonRaw.projects;
  if (projects && typeof projects === "object" && !Array.isArray(projects)) {
    const patchedProjects: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(projects as Record<string, unknown>)) {
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        patchedProjects[k] = v;
        continue;
      }
      const proj = { ...(v as Record<string, unknown>) };
      if ("mcpServers" in proj) {
        proj.mcpServers = filterMcpServers(proj.mcpServers, globs);
      }
      patchedProjects[k] = proj;
    }
    patchedClaudeJson.projects = patchedProjects;
  }
  const patchedClaudeJsonPath = join(policyDir, "claude-json.json");
  writeJsonAtomic(patchedClaudeJsonPath, patchedClaudeJson);

  const overrideMounts: Mount[] = [];
  const userSettings = readJsonOrNull(join(hostClaudeDir, "settings.json")) as
    | Record<string, unknown>
    | null;
  const enabledPlugins = userSettings?.enabledPlugins;

  // 2) Plugin `.mcp.json` + `plugin.json` (cache-backed).
  const plugins = listPluginsOnDisk(pluginsCacheDir, pluginsCacheContainerPath);
  for (const p of plugins) {
    if (!isPluginEnabled(enabledPlugins, p.key)) continue;
    for (const fname of [".mcp.json", "plugin.json"]) {
      const srcPath = join(p.hostDir, fname);
      if (!existsSync(srcPath)) continue;
      const raw = readJsonOrNull(srcPath);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const patched: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
      patched.mcpServers = filterMcpServers(
        (raw as Record<string, unknown>).mcpServers,
        globs,
      );
      const outPath = join(
        policyDir,
        "plugins",
        p.marketplace,
        p.plugin,
        p.version,
        fname,
      );
      writeJsonAtomic(outPath, patched);
      overrideMounts.push({
        src: outPath,
        dst: join(p.containerDir, fname),
        mode: "ro",
        source: { kind: "mcp-override", description: `plugin ${p.marketplace}/${p.plugin}@${p.version} ${fname}` },
      });
    }
  }

  // 3) Plugin `.mcp.json` + `plugin.json` (directory-sourced).
  for (const dp of listDirectoryPlugins(hostClaudeDir)) {
    if (!isPluginEnabled(enabledPlugins, dp.key)) continue;
    for (const fname of [".mcp.json", "plugin.json"]) {
      const srcPath = join(dp.hostDir, fname);
      if (!existsSync(srcPath)) continue;
      const raw = readJsonOrNull(srcPath);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const patched: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
      patched.mcpServers = filterMcpServers(
        (raw as Record<string, unknown>).mcpServers,
        globs,
      );
      const outPath = join(policyDir, "dir-plugins", dp.marketplace, dp.plugin, fname);
      writeJsonAtomic(outPath, patched);
      overrideMounts.push({
        src: outPath,
        dst: srcPath,
        mode: "ro",
        source: { kind: "mcp-override", description: `dir-plugin ${dp.marketplace}/${dp.plugin} ${fname}` },
      });
    }
  }

  // 4) Project `<repo>/.mcp.json` — glob AND approved.
  for (const r of repos) {
    const mcpPath = join(r.sessionClonePath, ".mcp.json");
    if (!existsSync(mcpPath)) continue;
    const raw = readJsonOrNull(mcpPath);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const servers = (raw as Record<string, unknown>).mcpServers;

    // Approval scopes read from host paths (matches `enumerateMcpServers`, so
    // the state users see via `ccairgap inspect` is the same one used to gate
    // the filter). `settings.local.json` is typically gitignored → not in the
    // session clone → host path is the only place it lives.
    const projSettings = readJsonOrNull(
      join(r.hostPath, ".claude", "settings.json"),
    ) as Record<string, unknown> | null;
    const projLocal = readJsonOrNull(
      join(r.hostPath, ".claude", "settings.local.json"),
    ) as Record<string, unknown> | null;

    let claudeJsonProjectEntry: Record<string, unknown> | null = null;
    if (projects && typeof projects === "object" && !Array.isArray(projects)) {
      const realRepo = tryRealpath(r.hostPath);
      for (const [k, v] of Object.entries(projects as Record<string, unknown>)) {
        if (
          tryRealpath(k) === realRepo &&
          v &&
          typeof v === "object" &&
          !Array.isArray(v)
        ) {
          claudeJsonProjectEntry = v as Record<string, unknown>;
          break;
        }
      }
    }
    const scopes = [userSettings, projSettings, projLocal, claudeJsonProjectEntry];

    const approvedSet = new Set<string>();
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      for (const name of Object.keys(servers as Record<string, unknown>)) {
        if (deriveApproval(name, scopes) === "approved") approvedSet.add(name);
      }
    }

    const filtered = filterMcpServers(servers, globs, approvedSet);
    const patched: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    patched.mcpServers = filtered;
    const outPath = join(policyDir, "projects", r.alternatesName, ".mcp.json");
    writeJsonAtomic(outPath, patched);
    overrideMounts.push({
      src: outPath,
      dst: join(r.hostPath, ".mcp.json"),
      mode: "ro",
      source: { kind: "mcp-override", description: `project ${r.basename} .mcp.json` },
    });
  }

  return { patchedClaudeJsonPath, overrideMounts };
}
