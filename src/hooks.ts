import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Mount } from "./mounts.js";

/**
 * Hook policy: default is "all hooks off". Users opt-in specific hooks by a glob
 * matched against the raw `command` string in each hook definition. Claude Code has
 * no native per-hook disable, so for non-empty enable lists we filter hook JSON at
 * three sources (user settings, enabled plugin hooks.json, project settings) and
 * deliver the patched files as nested bind mounts (single-file overlays).
 *
 * When `enableGlobs` is empty we skip filtering entirely and rely on Claude Code's
 * top-level `disableAllHooks: true` — cheapest path, catches everything including
 * sources we can't see (future plugin types, ad-hoc project settings).
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
   * one inside the container. Always produced (covers both empty-enable disableAllHooks
   * injection and non-empty filter pass).
   */
  patchedUserSettingsPath: string;
  /**
   * Nested single-file bind mounts:
   * - plugin hooks.json overrides (RO)
   * - per-repo project settings.json[.local] overrides (RO)
   * Empty when `enableGlobs` is empty.
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

function readJsonOrNull(path: string): unknown {
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
function isPluginEnabled(enabledPlugins: unknown, key: string): boolean {
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
interface PluginOnDisk {
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

function listPluginsOnDisk(cacheDir: string, containerCacheDir: string): PluginOnDisk[] {
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
 * Apply the hook policy. Always writes a patched user settings file; when the
 * enable list is non-empty, also writes filtered hooks.json / settings.json
 * copies under `$SESSION/hook-policy/` and returns single-file bind mounts that
 * overlay them on top of the RO plugin cache and the RW session clones.
 */
export function applyHookPolicy(input: ApplyHookPolicyInput): ApplyHookPolicyResult {
  const { policy, sessionDir, hostClaudeDir, pluginsCacheDir, pluginsCacheContainerPath, repos } =
    input;
  const globs = policy.enableGlobs;
  const policyDir = join(sessionDir, "hook-policy");

  // User settings — always produced.
  const hostUserSettings = (readJsonOrNull(join(hostClaudeDir, "settings.json")) ?? {}) as Record<
    string,
    unknown
  >;
  const patchedUser: Record<string, unknown> = { ...hostUserSettings };
  if (globs.length === 0) {
    patchedUser.disableAllHooks = true;
    patchedUser.hooks = {};
  } else {
    // Explicit false so a host-level `disableAllHooks: true` doesn't smother our opt-ins.
    patchedUser.disableAllHooks = false;
    patchedUser.hooks = filterHooksField(hostUserSettings.hooks, globs);
  }
  const patchedUserSettingsPath = join(policyDir, "user-settings.json");
  writeJsonAtomic(patchedUserSettingsPath, patchedUser);

  const overrideMounts: Mount[] = [];

  // Plugin hooks and project settings only need overlays when filtering is active.
  if (globs.length === 0) {
    return { patchedUserSettingsPath, overrideMounts };
  }

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
      });
    }
  }

  return { patchedUserSettingsPath, overrideMounts };
}
