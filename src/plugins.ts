import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/**
 * Extract absolute paths of local (directory/file-backed) plugin marketplaces from
 * host ~/.claude/settings.json. Mirrors spec §"Plugin marketplace discovery".
 *
 * Skips any path already under $HOME/.claude/ (already RO-mounted via /host-claude).
 * Dedupes after readlink -f resolution.
 */
export function discoverLocalMarketplaces(
  hostClaudeDir: string,
  homeDir: string,
): string[] {
  const settingsPath = join(hostClaudeDir, "settings.json");
  let settings: unknown;
  try {
    settings = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    return [];
  }

  const extra = (settings as { extraKnownMarketplaces?: Record<string, unknown> })
    .extraKnownMarketplaces;
  if (!extra || typeof extra !== "object") return [];

  const out = new Set<string>();
  const claudeRoot = hostClaudeDir.endsWith("/") ? hostClaudeDir : hostClaudeDir + "/";
  const homePrefix = homeDir.endsWith("/") ? homeDir + ".claude/" : homeDir + "/.claude/";

  for (const entry of Object.values(extra)) {
    const src = (entry as { source?: { source?: string; path?: string } })?.source;
    if (!src) continue;
    if (src.source !== "directory" && src.source !== "file") continue;
    if (typeof src.path !== "string") continue;

    let resolved: string;
    try {
      resolved = realpathSync(src.path);
    } catch {
      continue;
    }

    const check = resolved.endsWith("/") ? resolved : resolved + "/";
    if (check.startsWith(claudeRoot) || check.startsWith(homePrefix)) continue;

    out.add(resolved);
  }

  return [...out];
}
