import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  parseConfig,
  resolveConfigPath,
  resolveConfigPaths,
  type ConfigFile,
} from "./config.js";
import {
  loadIntegrationsDir,
  loadUserWideConfig,
  resolveUserWideDir,
} from "./userConfig.js";

/**
 * Provenance source for a key/element in the merged config.
 *
 * `mergeLayers` only emits the three "file-source" variants; the `cli`
 * variant is added by the post-pass in `cli.ts` when CLI flags override
 * a merged value. There is intentionally no `defaults` variant — defaults
 * are filled in by `mergeRun` in `cli.ts` AFTER the layered merge, and a
 * key absent from the provenance map means "no file-source set it".
 */
export type ScalarSource =
  | "user-wide"
  | "project"
  | "cli"
  | `user-wide-integration:${string}`;

export interface LayeredInput {
  integrations: Array<{ filename: string; config: ConfigFile }>;
  userWide?: ConfigFile;
  project?: ConfigFile;
}

export interface LayeredResult {
  merged: ConfigFile;
  /** Per-key provenance. Scalars: single ScalarSource. Arrays: source per element. Maps: per-key map. */
  provenance: Record<string, ScalarSource | ScalarSource[] | Record<string, ScalarSource>>;
}

const SCALAR_KEYS = [
  "repo", "base", "keepContainer", "dockerfile", "rebuild", "print",
  "name", "warnDockerArgs", "resume", "clipboard", "noPreserveDirty",
  "noAutoMemory", "refreshBelowTtl",
] as const;
const ARRAY_KEYS = [
  "extraRepo", "ro", "cp", "sync", "mount", "dockerRunArg", "claudeArgs",
] as const;
const SPECIAL_KEYS = ["hooks", "mcp", "dockerBuildArg"] as const;

// Compile-time exhaustiveness: any new ConfigFile key must be classified
// into exactly one bucket. Adding a key to `ConfigFile` without updating
// the lists above is a TypeScript error here.
type _ClassifiedKeys =
  | (typeof SCALAR_KEYS)[number]
  | (typeof ARRAY_KEYS)[number]
  | (typeof SPECIAL_KEYS)[number];
type _MissingKeys = Exclude<keyof ConfigFile, _ClassifiedKeys>;
type _ExtraKeys = Exclude<_ClassifiedKeys, keyof ConfigFile>;
const _exhaustive: [_MissingKeys, _ExtraKeys] extends [never, never]
  ? true
  : never = true;

/**
 * Merge integration files → user-wide config → project config into a single
 * `ConfigFile` (CLI is merged later in cli.ts). Tracks per-key provenance.
 *
 * Rules (matches existing project↔CLI semantics):
 *  - Scalars: later layer wins on present value.
 *  - Arrays: concat in load order, no dedup.
 *  - Maps (`dockerBuildArg`): per-key, later layer wins.
 *  - `hooks.enable` / `mcp.enable`: array-concat per parent.
 */
export function mergeLayers(input: LayeredInput): LayeredResult {
  const out: ConfigFile = {};
  const prov: LayeredResult["provenance"] = {};

  type Layer = { source: ScalarSource; cfg: ConfigFile };
  const layers: Layer[] = [];
  for (const ig of input.integrations) {
    layers.push({ source: `user-wide-integration:${ig.filename}`, cfg: ig.config });
  }
  if (input.userWide) layers.push({ source: "user-wide", cfg: input.userWide });
  if (input.project) layers.push({ source: "project", cfg: input.project });

  for (const k of SCALAR_KEYS) {
    for (const { source, cfg } of layers) {
      if (cfg[k] !== undefined) {
        (out as any)[k] = cfg[k];
        prov[k] = source;
      }
    }
  }

  for (const k of ARRAY_KEYS) {
    const collected: unknown[] = [];
    const collectedProv: ScalarSource[] = [];
    for (const { source, cfg } of layers) {
      const v = cfg[k] as unknown[] | undefined;
      if (v && v.length > 0) {
        for (const e of v) {
          collected.push(e);
          collectedProv.push(source);
        }
      }
    }
    if (collected.length > 0) {
      (out as any)[k] = collected;
      prov[k] = collectedProv;
    }
  }

  // hooks.enable, mcp.enable — same array-concat rule, nested under parent.
  for (const parent of ["hooks", "mcp"] as const) {
    const collected: string[] = [];
    const collectedProv: ScalarSource[] = [];
    for (const { source, cfg } of layers) {
      const v = cfg[parent]?.enable;
      if (v && v.length > 0) {
        for (const e of v) {
          collected.push(e);
          collectedProv.push(source);
        }
      }
    }
    if (collected.length > 0) {
      out[parent] = { enable: collected };
      prov[`${parent}.enable`] = collectedProv;
    }
  }

  // dockerBuildArg: per-key merge.
  const buildArg: Record<string, string> = {};
  const buildArgProv: Record<string, ScalarSource> = {};
  for (const { source, cfg } of layers) {
    if (!cfg.dockerBuildArg) continue;
    for (const [k, v] of Object.entries(cfg.dockerBuildArg)) {
      buildArg[k] = v;
      buildArgProv[k] = source;
    }
  }
  if (Object.keys(buildArg).length > 0) {
    out.dockerBuildArg = buildArg;
    prov.dockerBuildArg = buildArgProv;
  }

  return { merged: out, provenance: prov };
}

export interface LoadAllLayersOptions {
  /** Explicit --config <path>, if set. */
  configPath?: string;
  /** Explicit --profile <name>, if set. */
  profile?: string;
  /** True when --bare passed: skips user-wide and project launch-config. */
  bare: boolean;
  /** True unless --no-user-config: when false, skips the entire user-wide layer. */
  userConfigEnabled: boolean;
  /** Override cwd for tests. */
  cwd?: string;
  /** Override env for tests. */
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
}

export interface LoadedAllLayers {
  layered: LayeredResult;
  /** Resolved user-wide directory (independent of whether config.yaml was loaded). Used to gate the `/ccairgap-user-dir` mount. */
  userWideDir: string;
  /** Path of the loaded project config.yaml, if any. */
  projectPath?: string;
}

/**
 * Single source of truth for layered config loading. Used by both the
 * launch action and the inspect action so they share precedence semantics.
 */
export function loadAllLayers(opts: LoadAllLayersOptions): LoadedAllLayers {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = (env.HOME as string | undefined) ?? homedir();
  const userWideDir = resolveUserWideDir({ env, home });

  let integrations: Array<{ filename: string; config: ConfigFile }> = [];
  let userWide: ConfigFile | undefined;
  let userWideCfgPath: string | undefined;
  if (!opts.bare && opts.userConfigEnabled) {
    integrations = loadIntegrationsDir(join(userWideDir, "integrations")).map(
      (e) => ({ filename: e.filename, config: e.config }),
    );
    const r = loadUserWideConfig(userWideDir, { activeProfile: opts.profile });
    if (r) {
      userWide = r.config;
      userWideCfgPath = r.path;
    }
  }

  let project: ConfigFile | undefined;
  let projectPath: string | undefined;
  if (!opts.bare || opts.configPath || opts.profile) {
    const path = resolveConfigPath(opts.configPath, cwd, opts.profile, {
      userWideConfigPath: userWideCfgPath,
    });
    if (path) {
      // resolveConfigPath has already done discovery (with dotfiles-collision
      // check); parse the file directly. Calling loadConfig here would retrigger
      // resolveConfigPath without the userWideConfigPath option and double-warn.
      const text = readFileSync(path, "utf8");
      project = resolveConfigPaths(parseConfig(text, path), path);
      projectPath = path;
    }
  }

  const layered = mergeLayers({ integrations, userWide, project });
  return { layered, userWideDir, projectPath };
}
