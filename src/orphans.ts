import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import { sessionsDir } from "./paths.js";
import { readManifest } from "./manifest.js";
import { countCommitsAhead } from "./git.js";

export interface Orphan {
  ts: string;
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

  for (const ts of readdirSync(dir)) {
    const sd = join(dir, ts);
    if (!statSync(sd).isDirectory()) continue;
    if (running.has(`claude-airgap-${ts}`)) continue;

    let repos: string[] = [];
    const commits: Record<string, number> = {};
    try {
      const m = readManifest(sd, cliVer);
      repos = m.repos.map((r) => r.host_path);
      const branch = m.branch ?? `sandbox/${ts}`;
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

    out.push({ ts, sessionDir: sd, repos, commits });
  }

  return out;
}
