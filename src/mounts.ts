import { existsSync } from "node:fs";
import { join } from "node:path";

export type Mount = {
  src: string;
  dst: string;
  mode: "ro" | "rw";
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
  pluginsCacheDir: string;
  sessionTranscriptsDir: string;
  outputDir: string;
  repos: Array<{
    basename: string;
    sessionClonePath: string;
    hostPath: string;
    realGitDir: string;
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

  mounts.push({ src: i.hostClaudeDir, dst: "/host-claude", mode: "ro" });
  mounts.push({ src: i.hostClaudeJson, dst: "/host-claude-json", mode: "ro" });
  mounts.push({ src: i.hostCredsFile, dst: "/host-claude-creds", mode: "ro" });
  if (i.hostPatchedUserSettings) {
    mounts.push({
      src: i.hostPatchedUserSettings,
      dst: "/host-claude-patched-settings.json",
      mode: "ro",
    });
  }

  if (existsSync(i.pluginsCacheDir)) {
    mounts.push({
      src: i.pluginsCacheDir,
      dst: join(i.homeInContainer, ".claude", "plugins", "cache"),
      mode: "ro",
    });
  }

  mounts.push({
    src: i.sessionTranscriptsDir,
    dst: join(i.homeInContainer, ".claude", "projects"),
    mode: "rw",
  });

  mounts.push({ src: i.outputDir, dst: "/output", mode: "rw" });

  for (const r of i.repos) {
    mounts.push({ src: r.sessionClonePath, dst: r.hostPath, mode: "rw" });

    // Host objects are mounted at a NEUTRAL container path so they don't overlay
    // the session clone's own (RW) .git/objects/. The alternates file in the
    // session clone is rewritten (host-side, post-clone) to point here so reads
    // resolve through it while writes stay inside the session clone.
    const objDir = join(r.realGitDir, "objects");
    if (existsSync(objDir)) {
      mounts.push({
        src: objDir,
        dst: `/host-git-alternates/${r.basename}/objects`,
        mode: "ro",
      });
    }

    const lfsDir = join(r.realGitDir, "lfs", "objects");
    if (existsSync(lfsDir)) {
      mounts.push({
        src: lfsDir,
        dst: `/host-git-alternates/${r.basename}/lfs/objects`,
        mode: "ro",
      });
    }
  }

  for (const p of i.roPaths) {
    mounts.push({ src: p, dst: p, mode: "ro" });
  }

  for (const p of i.pluginMarketplaces) {
    mounts.push({ src: p, dst: p, mode: "ro" });
  }

  if (i.extraMounts) {
    for (const m of i.extraMounts) mounts.push(m);
  }

  return mounts;
}
