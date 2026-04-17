import { existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { readManifest, UnknownManifestVersionError } from "./manifest.js";
import { gitFetchSandbox, resolveGitDir } from "./git.js";
import { writeAlternates } from "./alternates.js";

export interface HandoffResult {
  sessionDir: string;
  ts: string;
  fetched: Array<{ hostPath: string; branch: string; ok: boolean }>;
  transcriptsCopied: number;
  removed: boolean;
  warnings: string[];
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

  if (!existsSync(sessionDirPath)) {
    warnings.push(`session dir does not exist: ${sessionDirPath}`);
    return { sessionDir: sessionDirPath, ts, fetched, transcriptsCopied, removed, warnings };
  }

  let manifest;
  try {
    manifest = readManifest(sessionDirPath, cliVersion);
  } catch (e) {
    if (e instanceof UnknownManifestVersionError) {
      warnings.push(e.message);
      return { sessionDir: sessionDirPath, ts, fetched, transcriptsCopied, removed, warnings };
    }
    warnings.push(`cannot read manifest: ${(e as Error).message}`);
    return { sessionDir: sessionDirPath, ts, fetched, transcriptsCopied, removed, warnings };
  }

  const branch = `sandbox/${ts}`;

  for (const repo of manifest.repos) {
    const sessionClone = join(sessionDirPath, "repos", repo.basename);
    if (!existsSync(repo.host_path)) {
      warnings.push(`host repo path gone, skipping fetch: ${repo.host_path}`);
      fetched.push({ hostPath: repo.host_path, branch, ok: false });
      continue;
    }
    if (!existsSync(sessionClone)) {
      warnings.push(`session clone missing, skipping fetch: ${sessionClone}`);
      fetched.push({ hostPath: repo.host_path, branch, ok: false });
      continue;
    }

    // The session clone's alternates points at a container-only path
    // (/host-git-alternates/...), so host git can't traverse history during
    // fetch. Rewrite alternates back to the real host objects path. The
    // session dir is deleted right after this loop either way.
    try {
      const realGitDir = resolveGitDir(repo.host_path);
      writeAlternates(sessionClone, join(realGitDir, "objects"));
    } catch (e) {
      warnings.push(`alternates rewrite failed for ${repo.host_path}: ${(e as Error).message}`);
    }

    const ok = await gitFetchSandbox(repo.host_path, sessionClone, branch);
    if (!ok) {
      warnings.push(`fetch failed for ${repo.host_path} (no commits on ${branch}?)`);
    }
    fetched.push({ hostPath: repo.host_path, branch, ok });
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

  try {
    rmSync(sessionDirPath, { recursive: true, force: true });
    removed = true;
  } catch (e) {
    warnings.push(`rm -rf session dir failed: ${(e as Error).message}`);
  }

  for (const w of warnings) logger(`[handoff] ${w}`);

  return { sessionDir: sessionDirPath, ts, fetched, transcriptsCopied, removed, warnings };
}
