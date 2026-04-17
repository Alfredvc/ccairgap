import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execaSync } from "execa";
import { parse as parseYaml } from "yaml";

/** Default config file path relative to git repo root. */
export const DEFAULT_CONFIG_REL = ".claude-airgap/config.yaml";

/**
 * All CLI options that can live in config. Camel-cased to match launch opts.
 * Undefined = unset (not "use default").
 */
export interface ConfigFile {
  repo?: string;
  extraRepo?: string[];
  ro?: string[];
  cp?: string[];
  sync?: string[];
  mount?: string[];
  base?: string;
  keepContainer?: boolean;
  dockerfile?: string;
  dockerBuildArg?: Record<string, string>;
  rebuild?: boolean;
  print?: string;
  name?: string;
}

/** yaml key → internal key. Accept kebab (matches CLI flags) or camel. */
const KEY_ALIASES: Record<string, keyof ConfigFile> = {
  "repo": "repo",
  "extra-repo": "extraRepo",
  "extraRepo": "extraRepo",
  "ro": "ro",
  "cp": "cp",
  "sync": "sync",
  "mount": "mount",
  "base": "base",
  "keep-container": "keepContainer",
  "keepContainer": "keepContainer",
  "dockerfile": "dockerfile",
  "docker-build-arg": "dockerBuildArg",
  "dockerBuildArg": "dockerBuildArg",
  "rebuild": "rebuild",
  "print": "print",
  "name": "name",
};

function gitRepoRoot(cwd: string): string | undefined {
  try {
    const { stdout, exitCode } = execaSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      reject: false,
    });
    if (exitCode !== 0) return undefined;
    const top = stdout.trim();
    return top.length > 0 ? top : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve config file to load.
 *  - If `explicit` set: must exist, absolute or resolved against cwd.
 *  - Else: git-repo-root/.claude-airgap/config.yaml if present, else none.
 */
export function resolveConfigPath(
  explicit: string | undefined,
  cwd: string = process.cwd(),
): string | undefined {
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(p)) {
      throw new Error(`--config file not found: ${p}`);
    }
    return p;
  }
  const root = gitRepoRoot(cwd);
  if (!root) return undefined;
  const p = join(root, DEFAULT_CONFIG_REL);
  return existsSync(p) ? p : undefined;
}

function assertStringArray(v: unknown, key: string): string[] {
  if (!Array.isArray(v)) throw new Error(`config.${key}: expected array of strings`);
  for (const item of v) {
    if (typeof item !== "string") {
      throw new Error(`config.${key}: expected string, got ${typeof item}`);
    }
  }
  return v as string[];
}

function assertStringMap(v: unknown, key: string): Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`config.${key}: expected map of KEY: VAL`);
  }
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== "string") {
      throw new Error(`config.${key}.${k}: expected string value`);
    }
    out[k] = val;
  }
  return out;
}

function assertString(v: unknown, key: string): string {
  if (typeof v !== "string") throw new Error(`config.${key}: expected string`);
  return v;
}

function assertBool(v: unknown, key: string): boolean {
  if (typeof v !== "boolean") throw new Error(`config.${key}: expected boolean`);
  return v;
}

/** Parse + validate yaml text. Throws on unknown keys or wrong types. */
export function parseConfig(text: string, source: string): ConfigFile {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (e) {
    throw new Error(`${source}: yaml parse error: ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) return {};
  if (typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(`${source}: top-level must be a map`);
  }

  const cfg: ConfigFile = {};
  for (const [rawKey, val] of Object.entries(doc as Record<string, unknown>)) {
    const normKey = KEY_ALIASES[rawKey];
    if (!normKey) {
      throw new Error(
        `${source}: unknown key '${rawKey}'. Allowed: ${Object.keys(KEY_ALIASES).join(", ")}`,
      );
    }
    switch (normKey) {
      case "repo":
        if (Array.isArray(val)) {
          throw new Error(
            `config.repo: expected single string (workspace). For multiple repos, use 'extra-repo' (array).`,
          );
        }
        cfg.repo = assertString(val, "repo");
        break;
      case "extraRepo":
        cfg.extraRepo = assertStringArray(val, "extra-repo");
        break;
      case "ro":
        cfg.ro = assertStringArray(val, "ro");
        break;
      case "cp":
        cfg.cp = assertStringArray(val, "cp");
        break;
      case "sync":
        cfg.sync = assertStringArray(val, "sync");
        break;
      case "mount":
        cfg.mount = assertStringArray(val, "mount");
        break;
      case "base":
        cfg.base = assertString(val, "base");
        break;
      case "keepContainer":
        cfg.keepContainer = assertBool(val, "keep-container");
        break;
      case "dockerfile":
        cfg.dockerfile = assertString(val, "dockerfile");
        break;
      case "dockerBuildArg":
        cfg.dockerBuildArg = assertStringMap(val, "docker-build-arg");
        break;
      case "rebuild":
        cfg.rebuild = assertBool(val, "rebuild");
        break;
      case "print":
        cfg.print = assertString(val, "print");
        break;
      case "name":
        cfg.name = assertString(val, "name");
        break;
    }
  }
  return cfg;
}

/** Load config from disk. Returns {} if no file. Throws on parse/validate error. */
export function loadConfig(
  explicit: string | undefined,
  cwd: string = process.cwd(),
): { path?: string; config: ConfigFile } {
  const path = resolveConfigPath(explicit, cwd);
  if (!path) return { config: {} };
  const text = readFileSync(path, "utf8");
  return { path, config: parseConfig(text, path) };
}

/**
 * Resolve config-file paths relative to the config file's directory.
 * Leaves absolute paths alone.
 */
export function resolveConfigPaths(cfg: ConfigFile, configPath: string): ConfigFile {
  const base = dirname(configPath);
  const fixPath = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  const out: ConfigFile = { ...cfg };
  if (cfg.repo) out.repo = fixPath(cfg.repo);
  if (cfg.extraRepo) out.extraRepo = cfg.extraRepo.map(fixPath);
  if (cfg.ro) out.ro = cfg.ro.map(fixPath);
  // cp/sync/mount: relative paths are resolved against repo root later,
  // not config dir. Leave as-is; artifacts.ts handles resolution.
  if (cfg.dockerfile) out.dockerfile = fixPath(cfg.dockerfile);
  return out;
}
