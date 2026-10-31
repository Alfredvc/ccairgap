import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * Plugin-root discovery for the hook and MCP policies.
 *
 * A "plugin root" is one directory Claude Code loads a plugin from. Claude Code
 * reads hook and MCP config from three files inside the root (see
 * https://code.claude.com/docs/en/plugins-reference):
 *   - `hooks/hooks.json` (default hooks file)
 *   - `.mcp.json` (default MCP file)
 *   - `.claude-plugin/plugin.json` (manifest). Its `hooks` and `mcpServers`
 *     fields add inline config or reference more `.json` files in the root.
 *
 * Cache-backed roots come from `installed_plugins.json` `installPath` entries.
 * Claude Code keeps previous versions in the cache with an `.orphaned_at`
 * marker for 14 days (https://code.claude.com/docs/en/plugins/loading.md
 * §"Cleanup of previous versions"), so a directory listing alone cannot tell
 * which version loads. Directory-sourced roots come from
 * `extraKnownMarketplaces[*].source.source === "directory"`.
 */

export const MANIFEST_REL = ".claude-plugin/plugin.json";
export const DEFAULT_HOOKS_REL = "hooks/hooks.json";
export const DEFAULT_MCP_REL = ".mcp.json";

export function readJsonOrNull(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** True if settings.json `enabledPlugins` entry is a literal `true`. */
export function isPluginEnabled(enabledPlugins: unknown, key: string): boolean {
  if (!enabledPlugins || typeof enabledPlugins !== "object") return false;
  const v = (enabledPlugins as Record<string, unknown>)[key];
  return v === true;
}

export interface PluginRoot {
  marketplace: string;
  plugin: string;
  /** Version directory name for cache-backed roots; `"directory"` for directory-sourced roots. */
  version: string;
  /** Claude Code enabledPlugins key, `<plugin>@<marketplace>`. */
  key: string;
  kind: "cache" | "directory";
  /** Host directory the policy reads files from. */
  hostDir: string;
  /**
   * Every container directory where Claude Code can read this root. A policy
   * overlay must land at each one. Cache-backed roots are visible at the
   * container-$HOME cache mount and at the host-absolute plugins mount (the
   * path `installed_plugins.json` records, which Claude Code reads). Both
   * collapse to one entry when host and container `~/.claude` coincide.
   */
  containerDirs: string[];
}

/**
 * Directory-sourced plugin: the marketplace entry in `settings.json` has
 * `source.source === "directory"`, so Claude Code resolves the plugin via
 * `<marketplaceDir>/.claude-plugin/marketplace.json` and reads the plugin's
 * own source tree — NOT `~/.claude/plugins/cache/`. The source tree is
 * RO-mounted 1:1 into the container by `discoverLocalMarketplaces`, so the
 * overlay dst = host path.
 */
export interface DirectoryPlugin {
  marketplace: string;
  plugin: string;
  /** Absolute resolved host path to the plugin's root. */
  hostDir: string;
  /** Absolute path to the plugin's default hooks.json (may not exist). */
  hooksJsonPath: string;
  /** Claude Code enabledPlugins key. */
  key: string;
}

export function listDirectoryPlugins(hostClaudeDir: string): DirectoryPlugin[] {
  const out: DirectoryPlugin[] = [];
  const settings = readJsonOrNull(join(hostClaudeDir, "settings.json"));
  if (!isPlainObject(settings)) return out;
  const extra = settings.extraKnownMarketplaces;
  if (!isPlainObject(extra)) return out;

  for (const [marketName, entry] of Object.entries(extra)) {
    const src = (entry as { source?: { source?: string; path?: string } })?.source;
    if (!src || src.source !== "directory" || typeof src.path !== "string") continue;
    let marketDir: string;
    try {
      marketDir = realpathSync(src.path);
    } catch {
      continue;
    }
    const mJson = readJsonOrNull(join(marketDir, ".claude-plugin", "marketplace.json")) as
      | { plugins?: unknown }
      | null;
    if (!mJson || !Array.isArray(mJson.plugins)) continue;
    for (const pRaw of mJson.plugins) {
      const p = pRaw as { name?: string; source?: unknown };
      if (typeof p?.name !== "string") continue;
      // `source` is optional and conventionally `"./"`; treat missing/non-string as `"./"`.
      const sourceRel = typeof p.source === "string" ? p.source : "./";
      const joined = isAbsolute(sourceRel) ? sourceRel : join(marketDir, sourceRel);
      let pluginDir: string;
      try {
        pluginDir = realpathSync(joined);
      } catch {
        continue;
      }
      out.push({
        marketplace: marketName,
        plugin: p.name,
        hostDir: pluginDir,
        hooksJsonPath: join(pluginDir, "hooks", "hooks.json"),
        key: `${p.name}@${marketName}`,
      });
    }
  }
  return out;
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Parse `installed_plugins.json` into `key → installPath[]`. Returns `null`
 * when the file is missing, unparseable, or has no `plugins` object. Every
 * scope's record is kept (user, project, local) because the policy must cover
 * any copy Claude Code might load.
 */
function readInstallRecords(recordsPath: string): Map<string, string[]> | null {
  if (!existsSync(recordsPath)) return null;
  const raw = readJsonOrNull(recordsPath);
  if (!isPlainObject(raw) || !isPlainObject(raw.plugins)) return null;
  const out = new Map<string, string[]>();
  for (const [key, entries] of Object.entries(raw.plugins)) {
    if (!Array.isArray(entries)) continue;
    const paths: string[] = [];
    for (const e of entries) {
      if (isPlainObject(e) && typeof e.installPath === "string") paths.push(e.installPath);
    }
    out.set(key, paths);
  }
  return out;
}

function splitKey(key: string): { plugin: string; marketplace: string } | null {
  const at = key.lastIndexOf("@");
  if (at <= 0 || at === key.length - 1) return null;
  return { plugin: key.slice(0, at), marketplace: key.slice(at + 1) };
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)];
}

/**
 * Enumerate cache-backed plugin roots.
 *
 * Primary source: `<cacheDir>/../installed_plugins.json`. Each `installPath`
 * that resolves to a directory inside `cacheDir` yields one root. A record
 * whose path leaves the cache is skipped (directory-sourced plugins are
 * handled by `listDirectoryPlugins`).
 *
 * Fallback when the records file is missing or unreadable: every
 * `<market>/<plugin>/<version>/` directory in the cache. This over-covers on
 * purpose, so a policy still filters whichever version Claude Code loads.
 *
 * @param containerCacheDir container-$HOME cache path. Pass `""` when only
 *   host paths matter (read-only enumeration for `inspect`).
 */
export function listCachePluginRoots(cacheDir: string, containerCacheDir: string): PluginRoot[] {
  if (!isDir(cacheDir)) return [];
  let realCache: string;
  try {
    realCache = realpathSync(cacheDir);
  } catch {
    return [];
  }

  const byHostDir = new Map<string, PluginRoot>();
  const add = (key: string, marketplace: string, plugin: string, rel: string): void => {
    const hostDir = join(cacheDir, rel);
    if (byHostDir.has(hostDir)) return;
    const relSegs = rel.split(sep);
    byHostDir.set(hostDir, {
      marketplace,
      plugin,
      version: relSegs.slice(2).join("/"),
      key,
      kind: "cache",
      hostDir,
      containerDirs: uniq([
        ...(containerCacheDir ? [join(containerCacheDir, rel)] : []),
        hostDir,
      ]),
    });
  };

  const records = readInstallRecords(join(cacheDir, "..", "installed_plugins.json"));
  if (records) {
    for (const [key, paths] of records) {
      const parts = splitKey(key);
      if (!parts) continue;
      for (const p of paths) {
        let real: string;
        try {
          real = realpathSync(p);
        } catch {
          continue;
        }
        const rel = relative(realCache, real);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
        if (!isDir(real)) continue;
        add(key, parts.marketplace, parts.plugin, rel);
      }
    }
    return [...byHostDir.values()];
  }

  const visible = (dir: string): string[] => {
    try {
      return readdirSync(dir).filter((n) => !n.startsWith(".") && isDir(join(dir, n)));
    } catch {
      return [];
    }
  };
  for (const market of visible(cacheDir)) {
    if (market.startsWith("temp_")) continue;
    for (const plugin of visible(join(cacheDir, market))) {
      for (const version of visible(join(cacheDir, market, plugin)).sort()) {
        add(`${plugin}@${market}`, market, plugin, join(market, plugin, version));
      }
    }
  }
  return [...byHostDir.values()];
}

/** Directory-sourced roots. The source tree mounts 1:1, so the container dir is the host dir. */
export function listDirectoryPluginRoots(hostClaudeDir: string): PluginRoot[] {
  return listDirectoryPlugins(hostClaudeDir).map((dp) => ({
    marketplace: dp.marketplace,
    plugin: dp.plugin,
    version: "directory",
    key: dp.key,
    kind: "directory" as const,
    hostDir: dp.hostDir,
    containerDirs: [dp.hostDir],
  }));
}

export interface ListEnabledPluginRootsInput {
  hostClaudeDir: string;
  pluginsCacheDir: string;
  /** Container-$HOME cache path; `""` for host-only enumeration. */
  pluginsCacheContainerPath: string;
}

/** Cache-backed and directory-sourced roots whose `enabledPlugins` key is `true` in user settings. */
export function listEnabledPluginRoots(input: ListEnabledPluginRootsInput): PluginRoot[] {
  const settings = readJsonOrNull(join(input.hostClaudeDir, "settings.json"));
  const enabledPlugins = isPlainObject(settings) ? settings.enabledPlugins : undefined;
  return [
    ...listCachePluginRoots(input.pluginsCacheDir, input.pluginsCacheContainerPath),
    ...listDirectoryPluginRoots(input.hostClaudeDir),
  ].filter((r) => isPluginEnabled(enabledPlugins, r.key));
}

/**
 * Resolve a manifest component path to a root-relative path (forward slashes).
 * Returns `null` for anything Claude Code would not load: absolute paths,
 * backslashes, paths outside the root (including through symlinks), and
 * missing files.
 */
export function resolveComponentPath(root: string, p: string): string | null {
  if (isAbsolute(p) || p.includes("\\")) return null;
  const rel = relative(root, join(root, p));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  const abs = join(root, rel);
  if (!existsSync(abs)) return null;
  try {
    const realRel = relative(realpathSync(root), realpathSync(abs));
    if (realRel === "" || realRel.startsWith("..") || isAbsolute(realRel)) return null;
  } catch {
    return null;
  }
  return rel.split(sep).join("/");
}

/** One element of a manifest `hooks` / `mcpServers` field, classified. */
export type ManifestComponentEntry =
  | { kind: "inline"; value: Record<string, unknown> }
  | { kind: "file"; raw: string; rel: string }
  /** `.mcpb` / `.dxt` bundle path or URL (`mcpServers` only). Server names are unknown host-side. */
  | { kind: "bundle"; raw: string }
  /** A path Claude Code would reject, or a value of the wrong type. */
  | { kind: "invalid"; raw: unknown };

const BUNDLE_RE = /\.(mcpb|dxt)$/i;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Classify a manifest `hooks` or `mcpServers` field. Both fields accept a
 * path, an inline object, or an array of either; `mcpServers` also accepts
 * bundle paths and URLs.
 */
export function classifyManifestField(
  root: string,
  field: unknown,
  component: "hooks" | "mcpServers",
): ManifestComponentEntry[] {
  const items = Array.isArray(field) ? field : [field];
  return items.map((item): ManifestComponentEntry => {
    if (isPlainObject(item)) return { kind: "inline", value: item };
    if (typeof item !== "string") return { kind: "invalid", raw: item };
    if (component === "mcpServers" && (BUNDLE_RE.test(item) || URL_RE.test(item))) {
      return { kind: "bundle", raw: item };
    }
    if (URL_RE.test(item)) return { kind: "invalid", raw: item };
    const rel = resolveComponentPath(root, item);
    return rel === null ? { kind: "invalid", raw: item } : { kind: "file", raw: item, rel };
  });
}

/** Read the plugin manifest. `null` when absent or not a JSON object. */
export function readPluginManifest(root: string): Record<string, unknown> | null {
  const raw = readJsonOrNull(join(root, MANIFEST_REL));
  return isPlainObject(raw) ? raw : null;
}

/**
 * The `mcpServers` map inside an MCP config file. `.mcp.json` and files that
 * a manifest names wrap the map in `mcpServers`; a file without that key is
 * read as the bare map.
 */
export function mcpServersOfFile(raw: unknown): unknown {
  if (!isPlainObject(raw)) return undefined;
  return "mcpServers" in raw ? raw.mcpServers : raw;
}

export interface PluginConfigSource {
  /** Host path of the file the config was read from. */
  sourcePath: string;
  /** Hook event map (`hooks`) or MCP server map (`mcpServers`). */
  value: unknown;
}

/**
 * Every hook event map Claude Code loads for this root: `hooks/hooks.json`,
 * inline manifest `hooks`, and each hooks file the manifest names.
 */
export function pluginHookSources(root: PluginRoot): PluginConfigSource[] {
  const out: PluginConfigSource[] = [];
  const seen = new Set<string>();
  const addFile = (rel: string): void => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const path = join(root.hostDir, rel);
    const raw = readJsonOrNull(path);
    if (isPlainObject(raw)) out.push({ sourcePath: path, value: raw.hooks });
  };
  if (existsSync(join(root.hostDir, DEFAULT_HOOKS_REL))) addFile(DEFAULT_HOOKS_REL);
  const manifest = readPluginManifest(root.hostDir);
  if (manifest && "hooks" in manifest) {
    for (const e of classifyManifestField(root.hostDir, manifest.hooks, "hooks")) {
      if (e.kind === "inline") out.push({ sourcePath: join(root.hostDir, MANIFEST_REL), value: e.value });
      else if (e.kind === "file") addFile(e.rel);
    }
  }
  return out;
}

/**
 * Every MCP server map Claude Code loads for this root: `.mcp.json`, inline
 * manifest `mcpServers`, and each `.json` file the manifest names. Bundles are
 * not listed because their server names are only known after extraction.
 */
export function pluginMcpSources(root: PluginRoot): PluginConfigSource[] {
  const out: PluginConfigSource[] = [];
  const seen = new Set<string>();
  const addFile = (rel: string): void => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const path = join(root.hostDir, rel);
    const servers = mcpServersOfFile(readJsonOrNull(path));
    if (servers !== undefined) out.push({ sourcePath: path, value: servers });
  };
  if (existsSync(join(root.hostDir, DEFAULT_MCP_REL))) addFile(DEFAULT_MCP_REL);
  const manifest = readPluginManifest(root.hostDir);
  if (manifest && "mcpServers" in manifest) {
    for (const e of classifyManifestField(root.hostDir, manifest.mcpServers, "mcpServers")) {
      if (e.kind === "inline") out.push({ sourcePath: join(root.hostDir, MANIFEST_REL), value: e.value });
      else if (e.kind === "file") addFile(e.rel);
    }
  }
  return out;
}
