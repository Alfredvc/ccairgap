import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { sessionsDir } from "./paths.js";
import { readManifest } from "./manifest.js";
import { countCommitsAhead } from "./git.js";

export interface Orphan {
  id: string;
  sessionDir: string;
  repos: string[];
  commits: Record<string, number>;
}

async function runningContainers(): Promise<Set<string>> {
  try {
    const { stdout } = await execa("docker", ["ps", "--format", "{{.Names}}"]);
    return new Set(stdout.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

/** Scan sessions dir; return sessions whose container is not running. */
export async function scanOrphans(cliVer: string): Promise<Orphan[]> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];

  const running = await runningContainers();
  const out: Orphan[] = [];

  for (const id of readdirSync(dir)) {
    const sd = join(dir, id);
    if (!statSync(sd).isDirectory()) continue;
    if (running.has(`ccairgap-${id}`)) continue;

    let repos: string[] = [];
    const commits: Record<string, number> = {};
    try {
      const m = readManifest(sd, cliVer);
      repos = m.repos.map((r) => r.host_path);
      // Pre-existing sessions from old CLI builds that wrote branches as
      // `sandbox/<id>` and omitted `branch` from the manifest — fall back so
      // commit counts still render for them. Legacy dirs use a timestamp as
      // their `id`, so the substitution remains correct.
      const branch = m.branch ?? `sandbox/${id}`;
      for (const r of m.repos) {
        const sessionClone = join(sd, "repos", r.basename);
        if (existsSync(sessionClone)) {
          commits[r.basename] = await countCommitsAhead(
            sessionClone,
            branch,
            r.base_ref ?? "HEAD",
          );
        }
      }
    } catch {
      // unreadable manifest: still list as orphan
    }

    out.push({ id, sessionDir: sd, repos, commits });
  }

  return out;
}
