import type { ConfigFile } from "./config.js";

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
