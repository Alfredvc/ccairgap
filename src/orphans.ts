import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sessionsDir } from "./paths.js";
import { readManifest } from "./manifest.js";
import { countCommitsAhead, dirtyTree } from "./git.js";
import { prepareLinkedWorktrees } from "./worktrees.js";
import { runningContainerNames } from "./sessionId.js";

export interface Orphan {
  id: string;
  sessionDir: string;
  repos: string[];
  commits: Record<string, number>;
  /**
   * Per-repo dirty-tree scan counts, keyed by `repos[].basename`. Only populated
   * for repos whose scan returned dirty (count > 0 for either field). Clean and
   * scan-failed repos are absent from the map.
   */
  dirty: Record<string, { modified: number; untracked: number }>;
}

/** Scan sessions dir; return sessions whose container is not running. */
export async function scanOrphans(cliVer: string): Promise<Orphan[]> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];

  const running = await runningContainerNames();
  const out: Orphan[] = [];

  for (const id of readdirSync(dir)) {
    const sd = join(dir, id);
    if (!statSync(sd).isDirectory()) continue;
    if (running.has(`ccairgap-${id}`)) continue;

    let repos: string[] = [];
    const commits: Record<string, number> = {};
    const dirty: Record<string, { modified: number; untracked: number }> = {};
    try {
      const m = readManifest(sd, cliVer);
      repos = m.repos.map((r) => r.host_path);
      // Pre-existing sessions from old CLI builds that wrote branches as
      // `sandbox/<id>` and omitted `branch` from the manifest — fall back so
      // commit counts still render for them. Legacy dirs use a timestamp as
      // their `id`, so the substitution remains correct.
      const branch = m.branch ?? `sandbox/${id}`;
      for (const r of m.repos) {
        const sessionClone = join(sd, "repos", r.alternates_name ?? r.basename);
        if (existsSync(sessionClone)) {
          commits[r.basename] = await countCommitsAhead(
            sessionClone,
            branch,
            r.base_ref ?? "HEAD",
          );
          const counts = { modified: 0, untracked: 0 };
          const addIfDirty = async (dir: string): Promise<void> => {
            const status = await dirtyTree(dir);
            if (status.kind === "dirty") {
              counts.modified += status.modified;
              counts.untracked += status.untracked;
            }
          };
          await addIfDirty(sessionClone);
          // The caller's `running` check protects a live container's paths.
          for (const wt of prepareLinkedWorktrees(sessionClone, r.host_path)) {
            if (wt.path !== null) await addIfDirty(wt.path);
          }
          if (counts.modified > 0 || counts.untracked > 0) dirty[r.basename] = counts;
        }
      }
    } catch {
      // unreadable manifest: still list as orphan
    }

    out.push({ id, sessionDir: sd, repos, commits, dirty });
  }

  return out;
}
