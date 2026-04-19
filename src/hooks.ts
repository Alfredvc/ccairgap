import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { Mount } from "./mounts.js";

/**
 * Hook policy: default is "all hooks off, statusLine on". Users opt-in specific
 * hooks by a glob matched against the raw `command` string in each hook definition.
 * Claude Code has no native per-hook disable, so we filter hook JSON at four sources
 * (user settings, cache-backed plugin hooks.json, directory-sourced plugin hooks.json,
 * project settings) and deliver the patched files as nested bind mounts (single-file
 * overlays).
 *
 * Why not `disableAllHooks: true` for the empty-enable case: that flag also disables
 * the custom `statusLine` (per Claude Code docs), so the cheap catch-all path silently
 * kills the user's statusline. Instead we explicitly set `disableAllHooks: false` and
 * neutralize every hook source by overlaying `hooks: {}`. statusLine survives via the
 * preserved user settings spread. Trade-off: any future hook source we don't enumerate
 * here would slip through — keep `enumerateHooks` and this filter list in lockstep.
 */
export interface HookPolicy {
  enableGlobs: string[];
}

export interface HookPolicyRepo {
  basename: string;
  sessionClonePath: string;
  hostPath: string;
}

export interface ApplyHookPolicyInput {
  policy: HookPolicy;
  sessionDir: string;
  /** Host ~/.claude/ (resolved). Read: settings.json. */
  hostClaudeDir: string;
  /** Host plugins cache. Read: each plugin's hooks/hooks.json. */
  pluginsCacheDir: string;
  /** Container path where the plugins cache mounts. Used to build nested override mount dsts. */
  pluginsCacheContainerPath: string;
  /** Session clones; used to find project `.claude/settings.json[.local]` and build override mount dsts at the container-facing repo path. */
  repos: HookPolicyRepo[];
}

export interface ApplyHookPolicyResult {
  /**
   * Absolute path on host of the patched user settings file to overlay the rsync'd
   * one inside the container. Always produced — empty enable list yields
   * `disableAllHooks: false` + `hooks: {}`; non-empty list filters down `hooks` to
   * surviving entries. statusLine and other unrelated keys are passed through.
   */
  patchedUserSettingsPath: string;
  /**
   * Nested single-file bind mounts:
   * - plugin hooks.json overrides (RO)
   * - per-repo project settings.json[.local] overrides (RO)
   * Always populated (one per hook-bearing source), regardless of `enableGlobs`.
   * With empty globs the patched files carry `hooks: {}`; with a non-empty list
   * the hooks field is filtered down to surviving entries.
   */
  overrideMounts: Mount[];
}

/** Convert a simple shell-ish glob (only `*` is a wildcard) to an anchored RegExp. */
export function globToRegex(glob: string): RegExp {
  let out = "";
  for (const ch of glob) {
    if (ch === "*") {
      out += ".*";
    } else {
      out += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

/** True iff `command` matches any glob in `globs`. Empty `globs` → always false. */
export function matchesEnable(command: string, globs: string[]): boolean {
  for (const g of globs) {
    if (globToRegex(g).test(command)) return true;
  }
  return false;
}

type HookEntry = { type?: string; command?: string; [k: string]: unknown };
type HookMatcherGroup = { matcher?: string; hooks?: HookEntry[]; [k: string]: unknown };
type HooksField = Record<string, HookMatcherGroup[]>;

/**
 * Filter a Claude Code `hooks` field, keeping only hook entries whose `command`
 * matches one of the globs. Matcher groups with no surviving entries are dropped.
 * Event arrays that become empty are dropped. Returns a new object.
 */
export function filterHooksField(hooks: unknown, globs: string[]): HooksField {
  const out: HooksField = {};
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return out;
  for (const [event, groupsRaw] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groupsRaw)) continue;
    const keptGroups: HookMatcherGroup[] = [];
    for (const group of groupsRaw as HookMatcherGroup[]) {
      if (!group || typeof group !== "object") continue;
      const inner = Array.isArray(group.hooks) ? group.hooks : [];
      const keptInner = inner.filter(
        (h) => typeof h?.command === "string" && matchesEnable(h.command, globs),
      );
      if (keptInner.length === 0) continue;
      keptGroups.push({ ...group, hooks: keptInner });
    }
    if (keptGroups.length > 0) out[event] = keptGroups;
  }
  return out;
}

export function readJsonOrNull(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o644 });
}

/** True if settings.json `enabledPlugins` entry is a literal `true`. */
export function isPluginEnabled(enabledPlugins: unknown, key: string): boolean {
  if (!enabledPlugins || typeof enabledPlugins !== "object") return false;
  const v = (enabledPlugins as Record<string, unknown>)[key];
  return v === true;
}

/**
 * Enumerate `<cache>/<marketplace>/<plugin>/<version>/` subtrees on disk. Each yields
 * a `<plugin>@<marketplace>` enabledPlugins key and an absolute host path.
 *
 * Version dir picked = single subdir when there's one; deterministic-sorted first
 * otherwise. Matches how Claude Code's cache is typically written (one version per
 * plugin); the fallback covers stale dirs without being wrong in practice.
 */
export interface PluginOnDisk {
  marketplace: string;
  plugin: string;
  version: string;
  /** Host path `<cache>/<marketplace>/<plugin>/<version>/`. */
  hostDir: string;
  /** Container path `<container-cache>/<marketplace>/<plugin>/<version>/`. */
  containerDir: string;
  /** Claude Code enabledPlugins key. */
  key: string;
}

/**
 * Directory-sourced plugin: the marketplace entry in `settings.json` has
 * `source.source === "directory"`, so Claude Code resolves the plugin via
 * `<marketplaceDir>/.claude-plugin/marketplace.json` and reads `hooks/hooks.json`
 * from the plugin's own source tree — NOT from `~/.claude/plugins/cache/`.
 *
 * The source tree is RO-mounted 1:1 into the container by `discoverLocalMarketplaces`,
 * so the overlay dst = host path. Without this the cache-only filter in
 * `listPluginsOnDisk` misses these plugins entirely and their hooks fire verbatim.
 */
export interface DirectoryPlugin {
  marketplace: string;
  plugin: string;
  /** Absolute resolved host path to the plugin's root (where `hooks/hooks.json` lives). */
  hostDir: string;
  /** Absolute path to the plugin's hooks.json (may not exist). */
  hooksJsonPath: string;
  /** Claude Code enabledPlugins key. */
  key: string;
}

export function listDirectoryPlugins(hostClaudeDir: string): DirectoryPlugin[] {
  const out: DirectoryPlugin[] = [];
  const settings = readJsonOrNull(join(hostClaudeDir, "settings.json")) as
    | Record<string, unknown>
    | null;
  if (!settings) return out;
  const extra = (settings as { extraKnownMarketplaces?: Record<string, unknown> })
    .extraKnownMarketplaces;
  if (!extra || typeof extra !== "object") return out;

  for (const [marketName, entry] of Object.entries(extra)) {
    const src = (entry as { source?: { source?: string; path?: string } })?.source;
    if (!src || src.source !== "directory" || typeof src.path !== "string") continue;
    let marketDir: string;
    try {
      marketDir = realpathSync(src.path);
    } catch {
      continue;
    }
    const mJsonPath = join(marketDir, ".claude-plugin", "marketplace.json");
    const mJson = readJsonOrNull(mJsonPath) as { plugins?: unknown } | null;
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

export function listPluginsOnDisk(cacheDir: string, containerCacheDir: string): PluginOnDisk[] {
  const out: PluginOnDisk[] = [];
  if (!existsSync(cacheDir)) return out;
  let markets: string[];
  try {
    markets = readdirSync(cacheDir);
  } catch {
    return out;
  }
  for (const market of markets) {
    if (market.startsWith(".") || market.startsWith("temp_")) continue;
    const marketDir = join(cacheDir, market);
    let plugins: string[];
    try {
      if (!statSync(marketDir).isDirectory()) continue;
      plugins = readdirSync(marketDir);
    } catch {
      continue;
    }
    for (const plugin of plugins) {
      if (plugin.startsWith(".")) continue;
      const pluginDir = join(marketDir, plugin);
      let versions: string[];
      try {
        if (!statSync(pluginDir).isDirectory()) continue;
        versions = readdirSync(pluginDir).filter((v) => {
          try {
            return statSync(join(pluginDir, v)).isDirectory();
          } catch {
            return false;
          }
        });
      } catch {
        continue;
      }
      if (versions.length === 0) continue;
      versions.sort();
      const version = versions[0]!;
      out.push({
        marketplace: market,
        plugin,
        version,
        hostDir: join(pluginDir, version),
        containerDir: join(containerCacheDir, market, plugin, version),
        key: `${plugin}@${market}`,
      });
    }
  }
  return out;
}

/**
 * Enumerate every hook entry the container would see at launch, across all three
 * sources (user settings, enabled plugins, project settings). Read-only mirror of
 * the sources `applyHookPolicy` walks, used by the `hooks` subcommand to surface
 * the raw `command` strings users need when choosing `--hook-enable` globs.
 *
 * `repos` here are host paths (not session clones) — the subcommand runs before
 * any session exists, so project `.claude/settings.json[.local]` is read straight
 * from the host repo.
 */
export type HookSource = "user" | "plugin" | "project";

export interface HookRecord {
  source: HookSource;
  sourcePath: string;
  event: string;
  matcher?: string;
  command: string;
  /** Plugin-only. */
  plugin?: { marketplace: string; plugin: string; version: string };
  /** Project-only. Repo basename. */
  repo?: string;
}

export interface EnumerateHooksInput {
  hostClaudeDir: string;
  pluginsCacheDir: string;
  repos: { basename: string; hostPath: string }[];
}

function collectHookRecords(
  hooksField: unknown,
  base: Omit<HookRecord, "event" | "matcher" | "command">,
  out: HookRecord[],
): void {
  if (!hooksField || typeof hooksField !== "object" || Array.isArray(hooksField)) return;
  for (const [event, groupsRaw] of Object.entries(hooksField as Record<string, unknown>)) {
    if (!Array.isArray(groupsRaw)) continue;
    for (const group of groupsRaw as HookMatcherGroup[]) {
      if (!group || typeof group !== "object") continue;
      const matcher = typeof group.matcher === "string" ? group.matcher : undefined;
      const inner = Array.isArray(group.hooks) ? group.hooks : [];
      for (const h of inner) {
        if (typeof h?.command !== "string") continue;
        out.push({ ...base, event, matcher, command: h.command });
      }
    }
  }
}

export function enumerateHooks(input: EnumerateHooksInput): HookRecord[] {
  const { hostClaudeDir, pluginsCacheDir, repos } = input;
  const out: HookRecord[] = [];

  // User settings.
  const userSettingsPath = join(hostClaudeDir, "settings.json");
  const userSettings = readJsonOrNull(userSettingsPath) as Record<string, unknown> | null;
  if (userSettings) {
    collectHookRecords(
      userSettings.hooks,
      { source: "user", sourcePath: userSettingsPath },
      out,
    );
  }

  // Plugin hooks (only enabled plugins).
  const enabledPlugins = userSettings?.enabledPlugins;
  // Container path irrelevant here; pass empty string.
  const plugins = listPluginsOnDisk(pluginsCacheDir, "");
  for (const p of plugins) {
    if (!isPluginEnabled(enabledPlugins, p.key)) continue;
    const hooksJsonPath = join(p.hostDir, "hooks", "hooks.json");
    if (!existsSync(hooksJsonPath)) continue;
    const raw = readJsonOrNull(hooksJsonPath);
    if (!raw || typeof raw !== "object") continue;
    collectHookRecords(
      (raw as { hooks?: unknown }).hooks,
      {
        source: "plugin",
        sourcePath: hooksJsonPath,
        plugin: { marketplace: p.marketplace, plugin: p.plugin, version: p.version },
      },
      out,
    );
  }

  // Directory-sourced plugins (loaded from the marketplace source tree, not cache).
  for (const dp of listDirectoryPlugins(hostClaudeDir)) {
    if (!isPluginEnabled(enabledPlugins, dp.key)) continue;
    if (!existsSync(dp.hooksJsonPath)) continue;
    const raw = readJsonOrNull(dp.hooksJsonPath);
    if (!raw || typeof raw !== "object") continue;
    collectHookRecords(
      (raw as { hooks?: unknown }).hooks,
      {
        source: "plugin",
        sourcePath: dp.hooksJsonPath,
        plugin: { marketplace: dp.marketplace, plugin: dp.plugin, version: "directory" },
      },
      out,
    );
  }

  // Project settings.
  for (const r of repos) {
    for (const fname of ["settings.json", "settings.local.json"]) {
      const p = join(r.hostPath, ".claude", fname);
      if (!existsSync(p)) continue;
      const raw = readJsonOrNull(p);
      if (!raw || typeof raw !== "object") continue;
      collectHookRecords(
        (raw as { hooks?: unknown }).hooks,
        { source: "project", sourcePath: p, repo: r.basename },
        out,
      );
    }
  }

  return out;
}

/**
 * Apply the hook policy. Writes a patched user settings file plus filtered
 * hooks.json / settings.json copies under `$SESSION/hook-policy/` for every
 * hook-bearing source, and returns single-file bind mounts that overlay them
 * on top of the RO plugin cache and the RW session clones.
 *
 * `disableAllHooks` is always set to `false` (so the custom `statusLine`
 * survives — see file-top comment). Hook neutralization happens by overlaying
 * filtered `hooks` fields at every source instead.
 */
export function applyHookPolicy(input: ApplyHookPolicyInput): ApplyHookPolicyResult {
  const { policy, sessionDir, hostClaudeDir, pluginsCacheDir, pluginsCacheContainerPath, repos } =
    input;
  const globs = policy.enableGlobs;
  const policyDir = join(sessionDir, "hook-policy");

  const hostUserSettings = (readJsonOrNull(join(hostClaudeDir, "settings.json")) ?? {}) as Record<
    string,
    unknown
  >;
  // Explicit false overrides any host-level `disableAllHooks: true` AND keeps
  // the custom statusLine alive (the flag would kill it).
  const patchedUser: Record<string, unknown> = {
    ...hostUserSettings,
    disableAllHooks: false,
    hooks: filterHooksField(hostUserSettings.hooks, globs),
  };
  const patchedUserSettingsPath = join(policyDir, "user-settings.json");
  writeJsonAtomic(patchedUserSettingsPath, patchedUser);

  const overrideMounts: Mount[] = [];
  const enabledPlugins = (hostUserSettings as { enabledPlugins?: unknown }).enabledPlugins;
  const plugins = listPluginsOnDisk(pluginsCacheDir, pluginsCacheContainerPath);
  for (const p of plugins) {
    if (!isPluginEnabled(enabledPlugins, p.key)) continue;
    const hooksJsonHost = join(p.hostDir, "hooks", "hooks.json");
    if (!existsSync(hooksJsonHost)) continue;
    const raw = readJsonOrNull(hooksJsonHost);
    if (!raw || typeof raw !== "object") continue;
    const rawHooks = (raw as { hooks?: unknown }).hooks;
    const filtered = filterHooksField(rawHooks, globs);
    const patched: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    patched.hooks = filtered;
    const outPath = join(
      policyDir,
      "plugins",
      p.marketplace,
      p.plugin,
      p.version,
      "hooks.json",
    );
    writeJsonAtomic(outPath, patched);
    overrideMounts.push({
      src: outPath,
      dst: join(p.containerDir, "hooks", "hooks.json"),
      mode: "ro",
      source: { kind: "hook-override", description: `plugin ${p.marketplace}/${p.plugin}@${p.version} hooks.json` },
    });
  }

  // Directory-sourced plugins: marketplace's source tree is RO-mounted 1:1, so
  // overlay at the host path (= container path for these mounts). Claude Code
  // reads hooks.json from here, not from the cache copy.
  for (const dp of listDirectoryPlugins(hostClaudeDir)) {
    if (!isPluginEnabled(enabledPlugins, dp.key)) continue;
    if (!existsSync(dp.hooksJsonPath)) continue;
    const raw = readJsonOrNull(dp.hooksJsonPath);
    if (!raw || typeof raw !== "object") continue;
    const rawHooks = (raw as { hooks?: unknown }).hooks;
    const filtered = filterHooksField(rawHooks, globs);
    const patched: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
    patched.hooks = filtered;
    const outPath = join(
      policyDir,
      "dir-plugins",
      dp.marketplace,
      dp.plugin,
      "hooks.json",
    );
    writeJsonAtomic(outPath, patched);
    overrideMounts.push({
      src: outPath,
      dst: dp.hooksJsonPath,
      mode: "ro",
      source: { kind: "hook-override", description: `dir-plugin ${dp.marketplace}/${dp.plugin} hooks.json` },
    });
  }

  // Project settings live inside each session clone. Overlay via nested file
  // bind mount targeting the container-facing repo path so the session clone on
  // disk stays byte-for-byte identical to what Claude checked out.
  for (const r of repos) {
    for (const fname of ["settings.json", "settings.local.json"]) {
      const src = join(r.sessionClonePath, ".claude", fname);
      if (!existsSync(src)) continue;
      const raw = readJsonOrNull(src);
      if (!raw || typeof raw !== "object") continue;
      const rawHooks = (raw as { hooks?: unknown }).hooks;
      const filtered = filterHooksField(rawHooks, globs);
      const patched: Record<string, unknown> = { ...(raw as Record<string, unknown>) };
      patched.hooks = filtered;
      const outPath = join(policyDir, "projects", r.basename, fname);
      writeJsonAtomic(outPath, patched);
      overrideMounts.push({
        src: outPath,
        dst: join(r.hostPath, ".claude", fname),
        mode: "ro",
        source: { kind: "hook-override", description: `project ${r.basename} .claude/${fname}` },
      });
    }
  }

  return { patchedUserSettingsPath, overrideMounts };
}
