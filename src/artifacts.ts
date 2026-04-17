import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { execa } from "execa";
import { realpath } from "./paths.js";
import type { Mount } from "./mounts.js";

/** Plan for a single --cp / --sync / --mount entry, resolved against repos. */
export interface ArtifactEntry {
  kind: "cp" | "sync" | "mount";
  /** Raw user-provided path, for diagnostics. */
  raw: string;
  /** Absolute host source path after relative-to-repo resolution. */
  srcHost: string;
  /** Absolute path the container sees. Equals srcHost (abs preserved). */
  containerPath: string;
  /**
   * For cp/sync only: where in the session dir the pre-launch copy lands.
   * - inside a session-cloned repo: `$SESSION/repos/<basename>/<rel>` (no extra mount needed — lives under the repo's RW mount).
   * - outside any repo: `$SESSION/artifacts/<abs>` (needs its own RW bind-mount).
   * Empty for --mount.
   */
  sessionSrc?: string;
  /** True iff `sessionSrc` is under a repo clone (not under $SESSION/artifacts). */
  insideRepoClone: boolean;
}

export interface RepoForArtifacts {
  basename: string;
  hostPath: string;
  sessionClonePath: string;
}

export interface ResolveArtifactsInput {
  cp: string[];
  sync: string[];
  mount: string[];
  repos: RepoForArtifacts[];
  /** Resolved --ro paths; used for overlap detection. */
  roPaths: string[];
  sessionDir: string;
}

export interface ResolveArtifactsResult {
  entries: ArtifactEntry[];
  /** Extra mounts to append to the docker args AFTER the repo mounts. */
  extraMounts: Mount[];
  /** Sync records to persist in the manifest for handoff copy-out. */
  syncRecords: Array<{ src_host: string; session_src: string }>;
  /** Warnings to print (non-fatal). */
  warnings: string[];
}

function diePrefix(msg: string): never {
  throw new Error(msg);
}

/**
 * Resolve cp/sync/mount lists:
 *  - relative → workspace repo root (first entry of `repos`); error if no repo
 *  - absolute → warn if outside all repos
 *  - must exist on host
 *  - no duplicate path across any of cp/sync/mount/ro/repos
 * Does not touch disk. Returns plan; caller executes via `executeCopies`.
 */
export function resolveArtifacts(i: ResolveArtifactsInput): ResolveArtifactsResult {
  const warnings: string[] = [];
  const entries: ArtifactEntry[] = [];

  const workspace = i.repos[0];

  const resolveOne = (kind: ArtifactEntry["kind"], raw: string): ArtifactEntry => {
    let abs: string;
    if (isAbsolute(raw)) {
      abs = resolve(raw);
    } else {
      if (!workspace) {
        diePrefix(
          `--${kind} ${raw}: relative path requires --repo (workspace). Use an absolute path or pass --repo.`,
        );
      }
      abs = resolve(workspace.hostPath, raw);
    }
    if (!existsSync(abs)) {
      diePrefix(`--${kind} ${raw}: host path does not exist (resolved to ${abs})`);
    }
    abs = realpath(abs);

    // Find owning repo (if any) by longest-prefix match.
    let owning: RepoForArtifacts | undefined;
    for (const r of i.repos) {
      const rp = r.hostPath.endsWith("/") ? r.hostPath : r.hostPath + "/";
      if (abs === r.hostPath || abs.startsWith(rp)) {
        if (!owning || r.hostPath.length > owning.hostPath.length) owning = r;
      }
    }

    if (isAbsolute(raw) && !owning) {
      warnings.push(
        `--${kind} ${raw}: absolute path is outside all --repo/--extra-repo trees; mounted at its absolute path inside the container`,
      );
    }

    const entry: ArtifactEntry = {
      kind,
      raw,
      srcHost: abs,
      containerPath: abs,
      insideRepoClone: false,
    };

    if (kind === "cp" || kind === "sync") {
      if (owning) {
        const rel = abs.substring(owning.hostPath.length).replace(/^\//, "");
        entry.sessionSrc = join(owning.sessionClonePath, rel);
        entry.insideRepoClone = true;
      } else {
        // Outside all repos: land under $SESSION/artifacts/<abs> (abs preserved).
        entry.sessionSrc = join(i.sessionDir, "artifacts", abs.replace(/^\//, ""));
        entry.insideRepoClone = false;
      }
    }
    return entry;
  };

  for (const p of i.cp) entries.push(resolveOne("cp", p));
  for (const p of i.sync) entries.push(resolveOne("sync", p));
  for (const p of i.mount) entries.push(resolveOne("mount", p));

  // Overlap detection across all mount sources.
  const seen = new Map<string, string>();
  const mark = (path: string, label: string) => {
    const prev = seen.get(path);
    if (prev) {
      diePrefix(`path ${path} used by both ${prev} and ${label}`);
    }
    seen.set(path, label);
  };
  for (const r of i.repos) mark(r.hostPath, `--repo/--extra-repo ${r.hostPath}`);
  for (const p of i.roPaths) mark(p, `--ro ${p}`);
  for (const e of entries) mark(e.srcHost, `--${e.kind} ${e.raw}`);

  // Build extra mounts: abs-source cp/sync (need their own bind), and all --mount.
  const extraMounts: Mount[] = [];
  const syncRecords: ResolveArtifactsResult["syncRecords"] = [];
  for (const e of entries) {
    if (e.kind === "mount") {
      extraMounts.push({ src: e.srcHost, dst: e.containerPath, mode: "rw" });
    } else if (!e.insideRepoClone && e.sessionSrc) {
      // cp/sync outside any repo: mount the pre-copied session scratch RW.
      extraMounts.push({ src: e.sessionSrc, dst: e.containerPath, mode: "rw" });
    }
    if (e.kind === "sync" && e.sessionSrc) {
      syncRecords.push({ src_host: e.srcHost, session_src: e.sessionSrc });
    }
  }

  return { entries, extraMounts, syncRecords, warnings };
}

/** rsync -a <src>/ <dst>/ preserving attrs. Creates dst parent. */
async function rsyncDir(src: string, dst: string): Promise<void> {
  mkdirSync(dirname(dst), { recursive: true });
  await execa("rsync", ["-a", "--delete", src.replace(/\/?$/, "/"), dst.replace(/\/?$/, "/")], {
    stdio: "inherit",
  });
}

/** cp -a <src> <dst> for files. Creates dst parent. */
async function copyFile(src: string, dst: string): Promise<void> {
  mkdirSync(dirname(dst), { recursive: true });
  await execa("cp", ["-a", src, dst], { stdio: "inherit" });
}

/**
 * Execute pre-launch copies for all cp/sync entries. Called AFTER the session
 * clone has been created (so in-repo relative paths can overwrite cloned state).
 */
export async function executeCopies(entries: ArtifactEntry[]): Promise<void> {
  for (const e of entries) {
    if (e.kind !== "cp" && e.kind !== "sync") continue;
    if (!e.sessionSrc) continue;
    const { statSync } = await import("node:fs");
    const st = statSync(e.srcHost);
    if (st.isDirectory()) {
      await rsyncDir(e.srcHost, e.sessionSrc);
    } else {
      await copyFile(e.srcHost, e.sessionSrc);
    }
  }
}
