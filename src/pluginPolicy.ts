import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { filterHooksField } from "./hooks.js";
import { filterMcpServers } from "./mcp.js";
import type { Mount } from "./mounts.js";
import {
  DEFAULT_HOOKS_REL,
  DEFAULT_MCP_REL,
  MANIFEST_REL,
  classifyManifestField,
  listEnabledPluginRoots,
  readJsonOrNull,
  readPluginManifest,
  type PluginRoot,
} from "./pluginRoots.js";

/**
 * Plugin half of the hook and MCP policies. For every enabled plugin root, the
 * CLI writes filtered copies of each file Claude Code reads hook or MCP config
 * from, and returns RO single-file bind mounts that overlay the copies at every
 * container path of that root:
 *
 * - `hooks/hooks.json`: `hooks` filtered by the hook globs.
 * - `.mcp.json`: `mcpServers` filtered by the MCP globs.
 * - `.claude-plugin/plugin.json`: inline `hooks` / `mcpServers` filtered;
 *   `.mcpb` / `.dxt` bundle entries removed (their server names cannot be
 *   matched host-side); entries Claude Code would reject removed.
 * - each `.json` file the manifest names under `hooks` or `mcpServers`:
 *   filtered like the default file of the same kind.
 *
 * One function owns all plugin files because a manifest or a named file can
 * carry both kinds of config, and two overlays on one path would collide.
 */
export interface ApplyPluginPolicyInput {
  hookEnableGlobs: string[];
  mcpEnableGlobs: string[];
  sessionDir: string;
  /** Host ~/.claude/ (resolved). Read: settings.json (enabledPlugins, extraKnownMarketplaces). */
  hostClaudeDir: string;
  /** Host plugins cache. Its parent holds `installed_plugins.json`. */
  pluginsCacheDir: string;
  /** Container path where the plugins cache mounts. */
  pluginsCacheContainerPath: string;
}

export interface ApplyPluginPolicyResult {
  overrideMounts: Mount[];
}

type Role = "hooks" | "mcp";

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o644 });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Filter one config file for the given roles. `null` when the file is not a JSON object. */
function patchConfigFile(
  raw: unknown,
  roles: Set<Role>,
  hookGlobs: string[],
  mcpGlobs: string[],
): Record<string, unknown> | null {
  if (!isPlainObject(raw)) return null;
  const patched: Record<string, unknown> = { ...raw };
  if (roles.has("hooks")) patched.hooks = filterHooksField(raw.hooks, hookGlobs);
  if (roles.has("mcp")) {
    // A file without an `mcpServers` key is read as the bare server map.
    // Filter it as a map, unless it is also a hooks file (wrapper shape).
    if ("mcpServers" in raw || roles.has("hooks")) {
      patched.mcpServers = filterMcpServers(raw.mcpServers, mcpGlobs);
    } else {
      return filterMcpServers(raw, mcpGlobs);
    }
  }
  return patched;
}

/**
 * Rewrite a manifest `hooks` / `mcpServers` field: filter inline objects, keep
 * valid file references (recording them in `files` for their own overlay),
 * drop bundles and invalid entries. Keeps the scalar-vs-array shape. Returns
 * `undefined` when nothing survives a scalar field, so the key is removed.
 */
function patchManifestField(
  root: PluginRoot,
  field: unknown,
  component: "hooks" | "mcpServers",
  globs: string[],
  files: Map<string, Set<Role>>,
): unknown {
  const role: Role = component === "hooks" ? "hooks" : "mcp";
  const kept: unknown[] = [];
  for (const e of classifyManifestField(root.hostDir, field, component)) {
    if (e.kind === "inline") {
      kept.push(
        component === "hooks" ? filterHooksField(e.value, globs) : filterMcpServers(e.value, globs),
      );
    } else if (e.kind === "file") {
      kept.push(e.raw);
      const roles = files.get(e.rel) ?? new Set<Role>();
      roles.add(role);
      files.set(e.rel, roles);
    }
  }
  if (Array.isArray(field)) return kept;
  return kept[0];
}

export function applyPluginPolicy(input: ApplyPluginPolicyInput): ApplyPluginPolicyResult {
  const { hookEnableGlobs, mcpEnableGlobs, sessionDir } = input;
  const policyDir = join(sessionDir, "plugin-policy");
  const overrideMounts: Mount[] = [];

  const roots = listEnabledPluginRoots({
    hostClaudeDir: input.hostClaudeDir,
    pluginsCacheDir: input.pluginsCacheDir,
    pluginsCacheContainerPath: input.pluginsCacheContainerPath,
  });

  for (const root of roots) {
    const outDir = join(
      policyDir,
      root.kind,
      root.marketplace,
      root.plugin,
      ...(root.kind === "cache" ? [root.version] : []),
    );
    const label = `${root.kind === "directory" ? "dir-plugin" : "plugin"} ${root.marketplace}/${root.plugin}@${root.version}`;
    const emit = (rel: string, patched: unknown): void => {
      const outPath = join(outDir, rel);
      writeJson(outPath, patched);
      for (const dir of root.containerDirs) {
        overrideMounts.push({
          src: outPath,
          dst: join(dir, rel),
          mode: "ro",
          source: { kind: "plugin-override", description: `${label} ${rel}` },
        });
      }
    };

    // Files to filter, with the kind(s) of config each one carries.
    const files = new Map<string, Set<Role>>();
    if (existsSync(join(root.hostDir, DEFAULT_HOOKS_REL))) files.set(DEFAULT_HOOKS_REL, new Set(["hooks"]));
    if (existsSync(join(root.hostDir, DEFAULT_MCP_REL))) {
      const roles = files.get(DEFAULT_MCP_REL) ?? new Set<Role>();
      roles.add("mcp");
      files.set(DEFAULT_MCP_REL, roles);
    }

    const manifest = readPluginManifest(root.hostDir);
    if (manifest && ("hooks" in manifest || "mcpServers" in manifest)) {
      const patched: Record<string, unknown> = { ...manifest };
      for (const [component, globs] of [
        ["hooks", hookEnableGlobs],
        ["mcpServers", mcpEnableGlobs],
      ] as const) {
        if (!(component in manifest)) continue;
        const next = patchManifestField(root, manifest[component], component, globs, files);
        if (next === undefined) delete patched[component];
        else patched[component] = next;
      }
      // A named file equal to the manifest itself is covered by this overlay.
      files.delete(MANIFEST_REL);
      emit(MANIFEST_REL, patched);
    }

    for (const [rel, roles] of files) {
      const patched = patchConfigFile(
        readJsonOrNull(join(root.hostDir, rel)),
        roles,
        hookEnableGlobs,
        mcpEnableGlobs,
      );
      if (patched !== null) emit(rel, patched);
    }
  }

  return { overrideMounts };
}
