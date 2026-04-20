import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execaSync } from "execa";
import { parse as parseYaml } from "yaml";

/** Default config file paths relative to git repo root (checked in order). */
export const DEFAULT_CONFIG_REL = ".ccairgap/config.yaml";
export const ALTERNATE_CONFIG_REL = ".config/ccairgap/config.yaml";

/** Valid profile name: alnum + `._-`, no slashes or empty. */
const PROFILE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Profile-scoped filename. `default` → `config.yaml` (back-compat with the
 * unprefixed default). Any other `<name>` → `<name>.config.yaml`.
 */
export function profileFilename(profile: string): string {
  return profile === "default" ? "config.yaml" : `${profile}.config.yaml`;
}

function assertProfileName(profile: string): void {
  if (!PROFILE_NAME_RE.test(profile)) {
    throw new Error(
      `--profile: invalid name '${profile}' (allowed: letters, digits, '.', '_', '-')`,
    );
  }
}

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
  hooks?: { enable?: string[] };
  mcp?: { enable?: string[] };
  dockerRunArg?: string[];
  warnDockerArgs?: boolean;
  resume?: string;
  clipboard?: boolean;
  noPreserveDirty?: boolean;
  /** Tokens forwarded verbatim to `claude` (subject to denylist). */
  claudeArgs?: string[];
  noAutoMemory?: boolean;
  /** Minutes. Host token ttl below this triggers pre-launch `claude auth login`. */
  refreshBelowTtl?: number;
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
  "resume": "resume",
  "name": "name",
  "hooks": "hooks",
  "mcp": "mcp",
  "docker-run-arg": "dockerRunArg",
  "dockerRunArg": "dockerRunArg",
  "warn-docker-args": "warnDockerArgs",
  "warnDockerArgs": "warnDockerArgs",
  "clipboard": "clipboard",
  "no-preserve-dirty": "noPreserveDirty",
  "noPreserveDirty": "noPreserveDirty",
  "claude-args": "claudeArgs",
  "claudeArgs": "claudeArgs",
  "no-auto-memory": "noAutoMemory",
  "noAutoMemory": "noAutoMemory",
  "refresh-below-ttl": "refreshBelowTtl",
  "refreshBelowTtl": "refreshBelowTtl",
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
 * Returns the host path of the `.ccairgap/` directory at the workspace repo
 * root when it exists, otherwise `undefined`. `cwd` should be the workspace
 * repo host path (not `process.cwd()`) so `--bare --repo <other>` resolves
 * correctly.
 */
export function resolveCcairgapDir(cwd: string = process.cwd()): string | undefined {
  const root = gitRepoRoot(cwd);
  if (!root) return undefined;
  const dir = join(root, ".ccairgap");
  return existsSync(dir) ? dir : undefined;
}

/**
 * Resolve config file to load.
 *  - `explicit` and `profile` are mutually exclusive (enforced at CLI layer).
 *  - If `explicit` set: must exist, absolute or resolved against cwd.
 *  - If `profile` set (and not `default`): look up `<root>/.ccairgap/<name>.config.yaml`,
 *    fallback `<root>/.config/ccairgap/<name>.config.yaml`. Missing = hard error
 *    (user explicitly asked for this profile). `profile: "default"` behaves
 *    identically to no profile.
 *  - Else: checks .ccairgap/config.yaml then .config/ccairgap/config.yaml under git root.
 */
export function resolveConfigPath(
  explicit: string | undefined,
  cwd: string = process.cwd(),
  profile?: string,
): string | undefined {
  if (explicit) {
    const p = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);
    if (!existsSync(p)) {
      throw new Error(`--config file not found: ${p}`);
    }
    return p;
  }
  const filename = profile !== undefined
    ? (assertProfileName(profile), profileFilename(profile))
    : "config.yaml";
  const primaryRel = `.ccairgap/${filename}`;
  const alternateRel = `.config/ccairgap/${filename}`;
  const root = gitRepoRoot(cwd);
  if (!root) {
    if (profile && profile !== "default") {
      throw new Error(
        `--profile ${profile}: not inside a git repo (expected ${primaryRel} or ${alternateRel} under git root)`,
      );
    }
    return undefined;
  }
  const primary = join(root, primaryRel);
  const alternate = join(root, alternateRel);
  const primaryExists = existsSync(primary);
  const alternateExists = existsSync(alternate);
  if (primaryExists && alternateExists) {
    console.error(
      `ccairgap: warning: both ${primaryRel} and ${alternateRel} ` +
        `found; using ${primaryRel}`,
    );
  }
  if (primaryExists) return primary;
  if (alternateExists) return alternate;
  if (profile && profile !== "default") {
    throw new Error(
      `--profile ${profile}: config file not found (looked for ${primary} and ${alternate})`,
    );
  }
  return undefined;
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

function assertNonNegativeNumber(v: unknown, key: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error(`config.${key}: expected non-negative number`);
  }
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
      case "resume":
        cfg.resume = assertString(val, "resume");
        break;
      case "name":
        cfg.name = assertString(val, "name");
        break;
      case "hooks":
        cfg.hooks = assertHooksBlock(val);
        break;
      case "mcp":
        cfg.mcp = assertMcpBlock(val);
        break;
      case "dockerRunArg":
        cfg.dockerRunArg = assertStringArray(val, "docker-run-arg");
        break;
      case "warnDockerArgs":
        cfg.warnDockerArgs = assertBool(val, "warn-docker-args");
        break;
      case "clipboard":
        cfg.clipboard = assertBool(val, "clipboard");
        break;
      case "noPreserveDirty":
        cfg.noPreserveDirty = assertBool(val, "no-preserve-dirty");
        break;
      case "claudeArgs":
        cfg.claudeArgs = assertStringArray(val, "claude-args");
        break;
      case "noAutoMemory":
        cfg.noAutoMemory = assertBool(val, "no-auto-memory");
        break;
      case "refreshBelowTtl":
        cfg.refreshBelowTtl = assertNonNegativeNumber(val, "refresh-below-ttl");
        break;
    }
  }
  return cfg;
}

function assertHooksBlock(v: unknown): { enable?: string[] } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("config.hooks: expected map (e.g. `hooks: { enable: [...] }`)");
  }
  const out: { enable?: string[] } = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "enable") {
      out.enable = assertStringArray(val, "hooks.enable");
    } else {
      throw new Error(`config.hooks.${k}: unknown key. Allowed: enable`);
    }
  }
  return out;
}

function assertMcpBlock(v: unknown): { enable?: string[] } {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("config.mcp: expected map (e.g. `mcp: { enable: [...] }`)");
  }
  const out: { enable?: string[] } = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "enable") {
      out.enable = assertStringArray(val, "mcp.enable");
    } else {
      throw new Error(`config.mcp.${k}: unknown key. Allowed: enable`);
    }
  }
  return out;
}

/** Load config from disk. Returns {} if no file. Throws on parse/validate error. */
export function loadConfig(
  explicit: string | undefined,
  cwd: string = process.cwd(),
  profile?: string,
): { path?: string; config: ConfigFile } {
  const path = resolveConfigPath(explicit, cwd, profile);
  if (!path) return { config: {} };
  const text = readFileSync(path, "utf8");
  return { path, config: parseConfig(text, path) };
}

/**
 * Resolve config-file paths. Two anchors, by semantic:
 *
 *  - Workspace-space paths (`repo`, `extra-repo`, `ro`) resolve against the
 *    "workspace anchor". When the config lives at either canonical location
 *    (`<git-root>/.ccairgap/config.yaml` or
 *    `<git-root>/.config/ccairgap/config.yaml`), the anchor is the git-root
 *    so users can write `repo: .`, `ro: ../docs`, `extra-repo: ../sibling`
 *    and have them mean what they say about their project. When `--config`
 *    points somewhere else, fall back to the config file's own directory.
 *
 *  - `dockerfile` resolves against the config file's directory (sidecar
 *    convention — the Dockerfile lives next to the config).
 *
 *  - `cp` / `sync` / `mount` are NOT resolved here — they anchor on the
 *    workspace repo root at launch time (see artifacts.ts).
 *
 * Absolute paths pass through untouched.
 */
export function resolveConfigPaths(cfg: ConfigFile, configPath: string): ConfigFile {
  const configDir = dirname(configPath);
  const parentDir = dirname(configDir);
  let workspaceAnchor: string;
  if (basename(configDir) === ".ccairgap") {
    workspaceAnchor = parentDir; // <git-root>/.ccairgap/config.yaml
  } else if (basename(configDir) === "ccairgap" && basename(parentDir) === ".config") {
    workspaceAnchor = dirname(parentDir); // <git-root>/.config/ccairgap/config.yaml
  } else {
    workspaceAnchor = configDir; // non-canonical --config path
  }
  const against = (anchor: string) => (p: string) =>
    isAbsolute(p) ? p : resolve(anchor, p);
  const viaWorkspace = against(workspaceAnchor);
  const viaConfigDir = against(configDir);
  const out: ConfigFile = { ...cfg };
  if (cfg.repo) out.repo = viaWorkspace(cfg.repo);
  if (cfg.extraRepo) out.extraRepo = cfg.extraRepo.map(viaWorkspace);
  if (cfg.ro) out.ro = cfg.ro.map(viaWorkspace);
  if (cfg.dockerfile) out.dockerfile = viaConfigDir(cfg.dockerfile);
  return out;
}
