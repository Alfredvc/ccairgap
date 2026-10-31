import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Mount } from "./mounts.js";
import { listEnabledPluginRoots, pluginHookSources, readJsonOrNull } from "./pluginRoots.js";

export { readJsonOrNull };

/**
 * Hook policy: default is "all hooks off, statusLine on". Users opt-in specific
 * hooks by a glob matched against the raw `command` string in each hook definition.
 * Claude Code has no native per-hook disable, so we filter hook JSON at every source
 * (user settings, project settings, and every enabled plugin) and deliver the patched
 * files as nested bind mounts (single-file overlays). This module owns user and
 * project settings; `applyPluginPolicy` in `src/pluginPolicy.ts` owns plugin files.
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
  /** Unique per-repo segment for policy scratch dirs. Produced by `alternatesName()`. */
  alternatesName: string;
}

export interface ApplyHookPolicyInput {
  policy: HookPolicy;
  sessionDir: string;
  /** Host ~/.claude/ (resolved). Read: settings.json. */
  hostClaudeDir: string;
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
   * Nested single-file bind mounts (RO), one per per-repo project
   * settings.json[.local]. Plugin files are overlaid by `applyPluginPolicy`.
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

function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o644 });
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

  // Plugin hooks: every enabled cache-backed and directory-sourced plugin root,
  // from `hooks/hooks.json` and the manifest `hooks` field. Container path is
  // irrelevant here; pass empty string.
  for (const root of listEnabledPluginRoots({
    hostClaudeDir,
    pluginsCacheDir,
    pluginsCacheContainerPath: "",
  })) {
    for (const src of pluginHookSources(root)) {
      collectHookRecords(
        src.value,
        {
          source: "plugin",
          sourcePath: src.sourcePath,
          plugin: { marketplace: root.marketplace, plugin: root.plugin, version: root.version },
        },
        out,
      );
    }
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
 * Apply the hook policy to user and project settings. Writes a patched user
 * settings file plus filtered project settings.json copies under
 * `$SESSION/hook-policy/`, and returns single-file bind mounts that overlay
 * them on top of the RW session clones. Plugin hook files are filtered by
 * `applyPluginPolicy` (`src/pluginPolicy.ts`).
 *
 * `disableAllHooks` is always set to `false` (so the custom `statusLine`
 * survives — see file-top comment). Hook neutralization happens by overlaying
 * filtered `hooks` fields at every source instead.
 */
export function applyHookPolicy(input: ApplyHookPolicyInput): ApplyHookPolicyResult {
  const { policy, sessionDir, hostClaudeDir, repos } = input;
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
      const outPath = join(policyDir, "projects", r.alternatesName, fname);
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
