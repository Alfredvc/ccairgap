import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { readManifest, UnknownManifestVersionError } from "./manifest.js";
import { gitFetchSandbox, resolveGitDir } from "./git.js";
import { writeAlternates } from "./alternates.js";
import { outputDir } from "./paths.js";

export type FetchStatus = "fetched" | "empty" | "failed";

export interface HandoffResult {
  sessionDir: string;
  ts: string;
  fetched: Array<{ hostPath: string; branch: string; status: FetchStatus }>;
  transcriptsCopied: number;
  removed: boolean;
  preserved: boolean;
  warnings: string[];
}

/** Count commits reachable from `branch` but not from any `origin/*` ref in the session clone. */
async function sandboxCommitCount(sessionClone: string, branch: string): Promise<number> {
  try {
    const { stdout } = await execa("git", [
      "-C",
      sessionClone,
      "rev-list",
      "--count",
      branch,
      "--not",
      "--remotes=origin",
    ]);
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Local branches (other than `excludeBranch`) that carry commits not present on
 * any `origin/*` ref. Used to detect work the user made on side branches when
 * the sandbox branch itself is empty — handoff only fetches sandbox/<ts>, so
 * those commits would be lost on rm -rf.
 */
async function orphanBranches(
  sessionClone: string,
  excludeBranch: string,
): Promise<Array<{ branch: string; count: number }>> {
  let names: string[];
  try {
    const { stdout } = await execa("git", [
      "-C",
      sessionClone,
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/",
    ]);
    names = stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.length > 0 && s !== excludeBranch);
  } catch {
    return [];
  }
  const out: Array<{ branch: string; count: number }> = [];
  for (const b of names) {
    try {
      const { stdout } = await execa("git", [
        "-C",
        sessionClone,
        "rev-list",
        "--count",
        b,
        "--not",
        "--remotes=origin",
      ]);
      const n = parseInt(stdout.trim(), 10) || 0;
      if (n > 0) out.push({ branch: b, count: n });
    } catch {
      // ignore individual branch failures
    }
  }
  return out;
}

/**
 * Idempotent handoff for a session dir. Used by both exit trap and `recover`.
 * Fails open: each step runs independently, errors are logged to warnings.
 */
export async function handoff(
  sessionDirPath: string,
  cliVersion: string,
  logger: (msg: string) => void = (m) => console.error(m),
): Promise<HandoffResult> {
  const ts = sessionDirPath.split("/").filter(Boolean).pop() ?? "<unknown>";
  const warnings: string[] = [];
  const fetched: HandoffResult["fetched"] = [];
  let transcriptsCopied = 0;
  let removed = false;
  let preserved = false;

  if (!existsSync(sessionDirPath)) {
    warnings.push(`session dir does not exist: ${sessionDirPath}`);
    return {
      sessionDir: sessionDirPath,
      ts,
      fetched,
      transcriptsCopied,
      removed,
      preserved,
      warnings,
    };
  }

  let manifest;
  try {
    manifest = readManifest(sessionDirPath, cliVersion);
  } catch (e) {
    if (e instanceof UnknownManifestVersionError) {
      warnings.push(e.message);
      return {
        sessionDir: sessionDirPath,
        ts,
        fetched,
        transcriptsCopied,
        removed,
        preserved,
        warnings,
      };
    }
    warnings.push(`cannot read manifest: ${(e as Error).message}`);
    return {
      sessionDir: sessionDirPath,
      ts,
      fetched,
      transcriptsCopied,
      removed,
      preserved,
      warnings,
    };
  }

  const branch = `sandbox/${ts}`;

  for (const repo of manifest.repos) {
    const sessionClone = join(sessionDirPath, "repos", repo.basename);
    if (!existsSync(repo.host_path)) {
      warnings.push(`host repo path gone, skipping fetch: ${repo.host_path}`);
      fetched.push({ hostPath: repo.host_path, branch, status: "failed" });
      continue;
    }
    if (!existsSync(sessionClone)) {
      warnings.push(`session clone missing, skipping fetch: ${sessionClone}`);
      fetched.push({ hostPath: repo.host_path, branch, status: "failed" });
      continue;
    }

    // The session clone's alternates points at a container-only path
    // (/host-git-alternates/...), so host git can't traverse history during
    // fetch or inspection. Rewrite alternates back to the real host objects
    // path unconditionally — useful for both the fetch below and any manual
    // inspection if we end up preserving the session.
    try {
      const realGitDir = resolveGitDir(repo.host_path);
      writeAlternates(sessionClone, join(realGitDir, "objects"));
    } catch (e) {
      warnings.push(`alternates rewrite failed for ${repo.host_path}: ${(e as Error).message}`);
    }

    const sandboxCount = await sandboxCommitCount(sessionClone, branch);
    if (sandboxCount === 0) {
      // No new commits on sandbox/<ts>. Don't pollute the host repo with an
      // empty branch ref. But if the user made commits on some other local
      // branch, those would be lost on rm -rf — preserve the session dir so
      // they can recover manually.
      const orphans = await orphanBranches(sessionClone, branch);
      if (orphans.length > 0) {
        preserved = true;
        const desc = orphans.map((o) => `${o.branch} (+${o.count})`).join(", ");
        warnings.push(
          `${repo.host_path}: ${branch} empty, but other local branches have commits: ${desc}. ` +
            `session preserved at ${sessionDirPath}. Inspect: \`git -C ${sessionClone} log <branch>\`. ` +
            `Drop when done: \`claude-airlock discard ${ts}\`.`,
        );
      }
      fetched.push({ hostPath: repo.host_path, branch, status: "empty" });
      continue;
    }

    const ok = await gitFetchSandbox(repo.host_path, sessionClone, branch);
    if (!ok) {
      warnings.push(`fetch failed for ${repo.host_path} (branch ${branch})`);
    }
    fetched.push({ hostPath: repo.host_path, branch, status: ok ? "fetched" : "failed" });
  }

  // --sync copy-out: mirror each session_src → $output/<ts>/<abs_src>/.
  // Idempotent (rsync -a). Best-effort: log on failure, keep going.
  if (manifest.sync && manifest.sync.length > 0) {
    const outRoot = join(outputDir(), ts);
    for (const s of manifest.sync) {
      if (!existsSync(s.session_src)) {
        warnings.push(`sync source missing, skipping: ${s.session_src}`);
        continue;
      }
      const dst = join(outRoot, s.src_host.replace(/^\//, ""));
      try {
        mkdirSync(dirname(dst), { recursive: true });
        const srcStat = statSync(s.session_src);
        if (srcStat.isDirectory()) {
          await execa("rsync", ["-a", s.session_src.replace(/\/?$/, "/"), dst.replace(/\/?$/, "/")]);
        } else {
          await execa("cp", ["-a", s.session_src, dst]);
        }
      } catch (e) {
        warnings.push(`--sync copy-out failed for ${s.src_host}: ${(e as Error).message}`);
      }
    }
  }

  const transcriptsDir = join(sessionDirPath, "transcripts");
  if (existsSync(transcriptsDir)) {
    const hostProjects = join(homedir(), ".claude", "projects");
    for (const entry of readdirSync(transcriptsDir)) {
      const src = join(transcriptsDir, entry);
      if (!statSync(src).isDirectory()) continue;
      const dst = join(hostProjects, entry);
      try {
        await execa("mkdir", ["-p", dst]);
        await execa("cp", ["-r", `${src}/.`, dst]);
        transcriptsCopied++;
      } catch (e) {
        warnings.push(`transcript copy failed for ${entry}: ${(e as Error).message}`);
      }
    }
  }

  if (preserved) {
    warnings.push(
      `session dir preserved at ${sessionDirPath}. Drop when done: \`claude-airlock discard ${ts}\`.`,
    );
  } else {
    try {
      rmSync(sessionDirPath, { recursive: true, force: true });
      removed = true;
    } catch (e) {
      warnings.push(`rm -rf session dir failed: ${(e as Error).message}`);
    }
  }

  for (const w of warnings) logger(`[handoff] ${w}`);

  return {
    sessionDir: sessionDirPath,
    ts,
    fetched,
    transcriptsCopied,
    removed,
    preserved,
    warnings,
  };
}
