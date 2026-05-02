import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseConfig, type ConfigFile } from "./config.js";
import {
  parseDockerRunArgs,
  validateIntegrationDockerRunArgs,
} from "./dockerRunArgs.js";

export interface ResolveUserWideDirInput {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  home: string;
}

/**
 * Resolve `~/.config/ccairgap/`. Honors `XDG_CONFIG_HOME` per the
 * XDG Base Directory Spec (empty value = unset).
 */
export function resolveUserWideDir(i: ResolveUserWideDirInput): string {
  const xdg = i.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(i.home, ".config");
  return join(base, "ccairgap");
}

const INTEGRATION_ALLOWED_KEYS: ReadonlySet<keyof ConfigFile> = new Set<keyof ConfigFile>([
  "hooks",
  "mcp",
  "dockerRunArg",
]);

export interface IntegrationFile {
  filename: string;
  path: string;
  config: ConfigFile;
}

/**
 * Load `<userWideDir>/integrations/*.yaml` in lexical order. Each file is
 * validated against the integration top-level-key allowlist (`hooks`, `mcp`,
 * `dockerRunArg` — the camelCase post-`parseConfig` keys) and its
 * `docker-run-arg` tokens are checked against the safe-flag allowlist
 * (`validateIntegrationDockerRunArgs`).
 *
 * Missing dir → empty array (not an error). Non-`.yaml` siblings are silently
 * ignored. YAML / type / allowlist errors are hard errors that name the file.
 *
 * Note: `parseConfig` already rejects unknown raw keys (`config.ts` throws
 * on any key outside `KEY_ALIASES`). The allowlist below operates on the
 * post-`parseConfig` `ConfigFile` keys, so it only fires on keys that are
 * valid for `config.yaml` but forbidden in integration files (e.g. `name`,
 * `repo`, `mount`, `cp`). No re-parse needed.
 */
export function loadIntegrationsDir(integrationsDir: string): IntegrationFile[] {
  if (!existsSync(integrationsDir)) return [];
  let names: string[];
  try {
    names = readdirSync(integrationsDir);
  } catch {
    return [];
  }
  const yamlFiles = names.filter((n) => n.endsWith(".yaml")).sort();
  const out: IntegrationFile[] = [];
  for (const filename of yamlFiles) {
    const path = join(integrationsDir, filename);
    const text = readFileSync(path, "utf8");
    let cfg: ConfigFile;
    try {
      cfg = parseConfig(text, path);
    } catch (e) {
      const msg = (e as Error).message;
      // parseConfig includes the full path in YAML parse errors but not in
      // type assertion errors (e.g. "config.hooks.enable: expected array").
      // Ensure the filename always appears in the thrown message.
      if (!msg.includes(filename)) {
        throw new Error(`${filename}: ${msg}`);
      }
      throw e;
    }
    enforceIntegrationKeyAllowlist(cfg, path);
    if (cfg.dockerRunArg && cfg.dockerRunArg.length > 0) {
      const tokens = parseDockerRunArgs(cfg.dockerRunArg);
      validateIntegrationDockerRunArgs(tokens, filename);
    }
    out.push({ filename, path, config: cfg });
  }
  return out;
}

function enforceIntegrationKeyAllowlist(cfg: ConfigFile, source: string): void {
  for (const k of Object.keys(cfg) as Array<keyof ConfigFile>) {
    if (!INTEGRATION_ALLOWED_KEYS.has(k)) {
      throw new Error(
        `${source}: key '${k}' not allowed in integration files ` +
          `(only ~/.config/ccairgap/config.yaml may set it); ` +
          `see docs/config.md#user-wide-config`,
      );
    }
  }
}
