import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveMountCollisions } from "./mountCollisions.js";

/**
 * Tagged origin of a mount. Carried on every `Mount` so the collision resolver
 * can emit source-aware error messages and the reserved-dst guard can
 * distinguish ccairgap-owned mounts from user-supplied ones.
 */
export type MountSource =
  | { kind: "host-claude" | "host-claude-json" | "host-creds" | "patched-settings" | "patched-claude-json" | "plugins-cache" | "plugins-host-path" | "transcripts" | "output" }
  | { kind: "repo"; hostPath: string }
  | { kind: "alternates"; repoHostPath: string; category: "objects" | "lfs" }
  | { kind: "ro"; path: string }
  | { kind: "marketplace"; path: string }
  | { kind: "artifact"; flag: "cp" | "sync" | "mount"; raw: string }
  | { kind: "hook-override"; description: string }
  | { kind: "mcp-override"; description: string };

export type Mount = {
  src: string;
  dst: string;
  mode: "ro" | "rw";
  source: MountSource;
};

export function mountArg(m: Mount): string[] {
  return ["-v", `${m.src}:${m.dst}:${m.mode}`];
}

export interface BuildMountsInput {
  hostClaudeDir: string;
  hostClaudeJson: string;
  hostCredsFile: string;
  /**
   * Host path of the patched settings.json produced by the hook-policy pass.
   * Mounted at `/host-claude-patched-settings.json` (single-file, RO); the
   * entrypoint overlays it on the rsync'd settings.json before the env-merge
   * jq step runs.
   */
  hostPatchedUserSettings?: string;
  /**
   * Host path of the patched `~/.claude.json` produced by the MCP-policy pass
   * (user + user-project `mcpServers` filtered). Mounted at
   * `/host-claude-patched-json` (single-file, RO); the entrypoint overlays it
   * on the copied `~/.claude.json` before the jq onboarding patch.
   */
  hostPatchedClaudeJson?: string;
  pluginsCacheDir: string;
  sessionTranscriptsDir: string;
  outputDir: string;
  repos: Array<{
    basename: string;
    sessionClonePath: string;
    hostPath: string;
    realGitDir: string;
    /**
     * Unique per-repo segment for alternates mount dsts (produced by
     * `alternatesName()`). Prevents two repos that share a `basename` from
     * colliding on `/host-git-alternates/<basename>/objects`.
     */
    alternatesName: string;
  }>;
  roPaths: string[];
  pluginMarketplaces: string[];
  homeInContainer: string;
  /** Extra mounts appended after repo mounts (so they can override paths inside a repo). */
  extraMounts?: Mount[];
}

/**
 * Build the full mount list per spec §"Container mount manifest".
 * Absolute host paths are preserved inside the container so settings.json refs resolve.
 */
export function buildMounts(i: BuildMountsInput): Mount[] {
  const mounts: Mount[] = [];

  mounts.push({ src: i.hostClaudeDir, dst: "/host-claude", mode: "ro", source: { kind: "host-claude" } });
  mounts.push({ src: i.hostClaudeJson, dst: "/host-claude-json", mode: "ro", source: { kind: "host-claude-json" } });
  mounts.push({ src: i.hostCredsFile, dst: "/host-claude-creds", mode: "ro", source: { kind: "host-creds" } });
  if (i.hostPatchedUserSettings) {
    mounts.push({ src: i.hostPatchedUserSettings, dst: "/host-claude-patched-settings.json", mode: "ro", source: { kind: "patched-settings" } });
  }
  if (i.hostPatchedClaudeJson) {
    mounts.push({ src: i.hostPatchedClaudeJson, dst: "/host-claude-patched-json", mode: "ro", source: { kind: "patched-claude-json" } });
  }

  if (existsSync(i.pluginsCacheDir)) {
    mounts.push({
      src: i.pluginsCacheDir,
      dst: join(i.homeInContainer, ".claude", "plugins", "cache"),
      mode: "ro",
      source: { kind: "plugins-cache" },
    });
  }

  // Host-abs-path mount of ~/.claude/plugins/. known_marketplaces.json and
  // installed_plugins.json store absolute host paths like
  // /Users/<user>/.claude/plugins/marketplaces/<name> and
  // /Users/<user>/.claude/plugins/cache/<market>/<plugin>/<ver>. The
  // container-$HOME plugins/cache mount above makes those paths resolvable only
  // when host $HOME matches container $HOME (/home/claude). For everything else
  // (normal macOS/Linux host) we need to surface plugins/ at its real host
  // absolute path too; otherwise Claude Code startup fails with
  // "Plugin X not found in marketplace Y" for github-sourced marketplaces.
  // Skip when host and container $HOME coincide (no new path) or when the dir
  // is absent.
  const hostPluginsDir = join(i.hostClaudeDir, "plugins");
  const containerClaudeDir = join(i.homeInContainer, ".claude");
  if (existsSync(hostPluginsDir) && i.hostClaudeDir !== containerClaudeDir) {
    mounts.push({
      src: hostPluginsDir,
      dst: hostPluginsDir,
      mode: "ro",
      source: { kind: "plugins-host-path" },
    });
  }

  mounts.push({
    src: i.sessionTranscriptsDir,
    dst: join(i.homeInContainer, ".claude", "projects"),
    mode: "rw",
    source: { kind: "transcripts" },
  });

  mounts.push({ src: i.outputDir, dst: "/output", mode: "rw", source: { kind: "output" } });

  for (const r of i.repos) {
    mounts.push({ src: r.sessionClonePath, dst: r.hostPath, mode: "rw", source: { kind: "repo", hostPath: r.hostPath } });

    // Host objects are mounted at a NEUTRAL container path so they don't overlay
    // the session clone's own (RW) .git/objects/. The alternates file in the
    // session clone is rewritten (host-side, post-clone) to point here so reads
    // resolve through it while writes stay inside the session clone.
    const objDir = join(r.realGitDir, "objects");
    if (existsSync(objDir)) {
      mounts.push({
        src: objDir,
        dst: `/host-git-alternates/${r.alternatesName}/objects`,
        mode: "ro",
        source: { kind: "alternates", repoHostPath: r.hostPath, category: "objects" },
      });
    }

    const lfsDir = join(r.realGitDir, "lfs", "objects");
    if (existsSync(lfsDir)) {
      mounts.push({
        src: lfsDir,
        dst: `/host-git-alternates/${r.alternatesName}/lfs/objects`,
        mode: "ro",
        source: { kind: "alternates", repoHostPath: r.hostPath, category: "lfs" },
      });
    }
  }

  for (const p of i.roPaths) {
    mounts.push({ src: p, dst: p, mode: "ro", source: { kind: "ro", path: p } });
  }

  for (const p of i.pluginMarketplaces) {
    mounts.push({ src: p, dst: p, mode: "ro", source: { kind: "marketplace", path: p } });
  }

  if (i.extraMounts) {
    for (const m of i.extraMounts) mounts.push(m);
  }

  const resolved = resolveMountCollisions(mounts, { homeInContainer: i.homeInContainer });
  return resolved.mounts;
}
