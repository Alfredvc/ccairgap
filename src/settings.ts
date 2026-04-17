import { join } from "node:path";
import { readJsonOrNull } from "./hooks.js";

/**
 * Read-only enumeration of two settings-file fields the `ccairgap inspect`
 * subcommand surfaces so skills / users don't have to hand-walk config:
 *
 * - `env` — environment variables Claude Code injects into its own process at
 *   launch. Plugins, MCP servers, and hook subprocesses inherit this.
 * - `extraKnownMarketplaces` — plugin marketplace registrations. Skill uses
 *   these to know which host paths ccairgap will auto-RO-mount (directory/file
 *   source types) versus remote-only marketplaces that need no host mount.
 *
 * Sources walked (all three are plain settings JSON):
 * - `user`    — `~/.claude/settings.json`
 * - `project` — `<repo>/.claude/settings.json`
 *               `<repo>/.claude/settings.local.json`
 *
 * Managed-settings tiers (OS-level, MDM, server-delivered) are intentionally
 * omitted — they aren't mounted into the container and don't affect what
 * Claude sees inside the sandbox. This matches `enumerateHooks` /
 * `enumerateMcpServers`, which also stop at user + plugin + project scope.
 *
 * Plugin manifests cannot declare either field per Claude Code's schema, so
 * plugin-scope enumeration is not applicable here.
 */
export type SettingsSource = "user" | "project";

export interface EnvRecord {
  source: SettingsSource;
  sourcePath: string;
  name: string;
  value: string;
  /** `project` source only: repo basename. */
  repo?: string;
}

export interface MarketplaceRecord {
  source: SettingsSource;
  sourcePath: string;
  name: string;
  /**
   * Raw marketplace entry as written under `extraKnownMarketplaces[name]`.
   * Usually has shape `{ source: { source: "github"|"git"|"directory"|..., ... } }`
   * or for `source: "settings"` may declare plugins inline instead of pointing
   * to an external location.
   */
  entry: Record<string, unknown>;
  /**
   * Convenience: `entry.source.source` when the record has that shape. One of
   * `github | git | directory | file | hostPattern | settings`. Undefined when
   * the entry is malformed or uses an unrecognized shape.
   */
  sourceType?: string;
  /**
   * Convenience for directory/file source types: the host path from
   * `entry.source.path`. Preserved as written — not realpath'd. Undefined for
   * other source types.
   */
  hostPath?: string;
  /** `project` source only: repo basename. */
  repo?: string;
}

export interface EnumerateSettingsInput {
  hostClaudeDir: string;
  repos: { basename: string; hostPath: string }[];
}

/** Ordered list of (sourcePath, scope, repo?) tuples the walker iterates. */
function settingsFiles(
  input: EnumerateSettingsInput,
): { sourcePath: string; source: SettingsSource; repo?: string }[] {
  const out: { sourcePath: string; source: SettingsSource; repo?: string }[] = [];
  out.push({
    sourcePath: join(input.hostClaudeDir, "settings.json"),
    source: "user",
  });
  for (const r of input.repos) {
    for (const fname of ["settings.json", "settings.local.json"]) {
      out.push({
        sourcePath: join(r.hostPath, ".claude", fname),
        source: "project",
        repo: r.basename,
      });
    }
  }
  return out;
}

export function enumerateEnv(input: EnumerateSettingsInput): EnvRecord[] {
  const out: EnvRecord[] = [];
  for (const f of settingsFiles(input)) {
    const raw = readJsonOrNull(f.sourcePath);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const env = (raw as { env?: unknown }).env;
    if (!env || typeof env !== "object" || Array.isArray(env)) continue;
    for (const [name, value] of Object.entries(env as Record<string, unknown>)) {
      if (typeof value !== "string") continue;
      const rec: EnvRecord = {
        source: f.source,
        sourcePath: f.sourcePath,
        name,
        value,
      };
      if (f.repo !== undefined) rec.repo = f.repo;
      out.push(rec);
    }
  }
  return out;
}

export function enumerateMarketplaces(input: EnumerateSettingsInput): MarketplaceRecord[] {
  const out: MarketplaceRecord[] = [];
  for (const f of settingsFiles(input)) {
    const raw = readJsonOrNull(f.sourcePath);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const extra = (raw as { extraKnownMarketplaces?: unknown }).extraKnownMarketplaces;
    if (!extra || typeof extra !== "object" || Array.isArray(extra)) continue;
    for (const [name, entryRaw] of Object.entries(extra as Record<string, unknown>)) {
      if (!entryRaw || typeof entryRaw !== "object" || Array.isArray(entryRaw)) continue;
      const entry = entryRaw as Record<string, unknown>;
      const rec: MarketplaceRecord = {
        source: f.source,
        sourcePath: f.sourcePath,
        name,
        entry,
      };
      const src = entry.source;
      if (src && typeof src === "object" && !Array.isArray(src)) {
        const srcObj = src as Record<string, unknown>;
        if (typeof srcObj.source === "string") rec.sourceType = srcObj.source;
        if (
          (rec.sourceType === "directory" || rec.sourceType === "file") &&
          typeof srcObj.path === "string"
        ) {
          rec.hostPath = srcObj.path;
        }
      }
      if (f.repo !== undefined) rec.repo = f.repo;
      out.push(rec);
    }
  }
  return out;
}
