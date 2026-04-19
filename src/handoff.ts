import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { readManifest, UnknownManifestVersionError } from "./manifest.js";
import { gitFetchSandbox, resolveGitDir, dirtyTree } from "./git.js";
import { writeAlternates } from "./alternates.js";
import { outputDir } from "./paths.js";

export type FetchStatus = "fetched" | "empty" | "failed";

export interface HandoffResult {
  sessionDir: string;
  id: string;
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
 * the sandbox branch itself is empty — handoff only fetches ccairgap/<id>, so
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
 *
 * Preservation triggers (any one prevents the terminal `rm -rf`):
 *  - dirty working tree in any session clone (skipped if `noPreserveDirty`)
 *  - dirty scan failed for any repo (unknown state → err on preserve)
 *  - the sandbox branch is empty AND another local branch carries commits not
 *    on `origin/*` (existing orphan-branch logic)
 */
export async function handoff(
  sessionDirPath: string,
  cliVersion: string,
  logger: (msg: string) => void = (m) => console.error(m),
  opts: { noPreserveDirty?: boolean } = {},
): Promise<HandoffResult> {
  const id = sessionDirPath.split("/").filter(Boolean).pop() ?? "<unknown>";
  const warnings: string[] = [];
  const fetched: HandoffResult["fetched"] = [];
  let transcriptsCopied = 0;
  let removed = false;

  if (!existsSync(sessionDirPath)) {
    warnings.push(`session dir does not exist: ${sessionDirPath}`);
    return {
      sessionDir: sessionDirPath,
      id,
      fetched,
      transcriptsCopied,
      removed,
      preserved: false,
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
        id,
        fetched,
        transcriptsCopied,
        removed,
        preserved: false,
        warnings,
      };
    }
    warnings.push(`cannot read manifest: ${(e as Error).message}`);
    return {
      sessionDir: sessionDirPath,
      id,
      fetched,
      transcriptsCopied,
      removed,
      preserved: false,
      warnings,
    };
  }

  const branch = manifest.branch ?? `sandbox/${id}`;

  // Preservation accumulators — populated in the per-repo loop.
  const dirtyRepos: Array<{
    hostPath: string;
    sessionClone: string;
    modified: number;
    untracked: number;
  }> = [];
  const orphanRepos: Array<{
    hostPath: string;
    sessionClone: string;
    branches: Array<{ branch: string; count: number }>;
  }> = [];
  const scanFailedRepos: Array<{
    hostPath: string;
    sessionClone: string;
    error: string;
  }> = [];

  for (const repo of manifest.repos) {
    const sessionClone = join(
      sessionDirPath,
      "repos",
      repo.alternates_name ?? repo.basename,
    );
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

    // Rewrite alternates back to the real host objects path. Required before
    // dirtyTree()'s `git status` and the fetch below.
    try {
      const realGitDir = resolveGitDir(repo.host_path);
      writeAlternates(sessionClone, join(realGitDir, "objects"));
    } catch (e) {
      warnings.push(
        `alternates rewrite failed for ${repo.host_path}: ${(e as Error).message}`,
      );
    }

    // Dirty-tree detection — runs for every repo (not only empty-sandbox).
    // `noPreserveDirty` only suppresses the `dirty` branch; `scan-failed`
    // still preserves (per spec: uncertainty → err on preserve). See the
    // invariant in CLAUDE.md.
    const status = await dirtyTree(sessionClone);
    if (status.kind === "dirty" && !opts.noPreserveDirty) {
      dirtyRepos.push({
        hostPath: repo.host_path,
        sessionClone,
        modified: status.modified,
        untracked: status.untracked,
      });
    } else if (status.kind === "scan-failed") {
      scanFailedRepos.push({
        hostPath: repo.host_path,
        sessionClone,
        error: status.error,
      });
    }

    const sandboxCount = await sandboxCommitCount(sessionClone, branch);
    if (sandboxCount === 0) {
      const orphans = await orphanBranches(sessionClone, branch);
      if (orphans.length > 0) {
        orphanRepos.push({
          hostPath: repo.host_path,
          sessionClone,
          branches: orphans,
        });
      }
      fetched.push({ hostPath: repo.host_path, branch, status: "empty" });
      continue;
    }

    const ok = await gitFetchSandbox(repo.host_path, sessionClone, branch);
    if (!ok) {
      warnings.push(`fetch failed for ${repo.host_path} (branch ${branch})`);
    }
    fetched.push({
      hostPath: repo.host_path,
      branch,
      status: ok ? "fetched" : "failed",
    });
  }

  // --sync copy-out (unchanged).
  if (manifest.sync && manifest.sync.length > 0) {
    const outRoot = join(outputDir(), id);
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
          await execa("rsync", [
            "-a",
            s.session_src.replace(/\/?$/, "/"),
            dst.replace(/\/?$/, "/"),
          ]);
        } else {
          await execa("cp", ["-a", s.session_src, dst]);
        }
      } catch (e) {
        warnings.push(
          `--sync copy-out failed for ${s.src_host}: ${(e as Error).message}`,
        );
      }
    }
  }

  // Transcripts copy-out (unchanged).
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
        warnings.push(
          `transcript copy failed for ${entry}: ${(e as Error).message}`,
        );
      }
    }
  }

  const preserved =
    dirtyRepos.length > 0 ||
    orphanRepos.length > 0 ||
    scanFailedRepos.length > 0;

  if (preserved) {
    emitPreservationWarnings({
      warnings,
      sessionDirPath,
      id,
      dirtyRepos,
      orphanRepos,
      scanFailedRepos,
    });
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
    id,
    fetched,
    transcriptsCopied,
    removed,
    preserved,
    warnings,
  };
}

/**
 * Format the preservation message into `warnings[]` (one entry per line, so
 * the logger prefix `[handoff] ` lands on each rendered line).
 *
 * Three shapes:
 *  - dirty-only (no orphan, no scan-fail): full discard hint OK.
 *  - combined (dirty or scan-fail + orphan): discard hint suppressed —
 *    discarding would lose orphan-branch commits.
 *  - scan-failed alone: warning says "state unknown, session preserved out
 *    of caution" and points at `discard` as the exit (user can't run
 *    `git status` on a corrupt clone).
 */
function emitPreservationWarnings(arg: {
  warnings: string[];
  sessionDirPath: string;
  id: string;
  dirtyRepos: Array<{
    hostPath: string;
    sessionClone: string;
    modified: number;
    untracked: number;
  }>;
  orphanRepos: Array<{
    hostPath: string;
    sessionClone: string;
    branches: Array<{ branch: string; count: number }>;
  }>;
  scanFailedRepos: Array<{
    hostPath: string;
    sessionClone: string;
    error: string;
  }>;
}): void {
  const { warnings, sessionDirPath, id, dirtyRepos, orphanRepos, scanFailedRepos } = arg;
  const hasOrphan = orphanRepos.length > 0;

  // Per-trigger summary lines.
  for (const d of dirtyRepos) {
    const parts: string[] = [];
    if (d.modified > 0) {
      parts.push(`${d.modified} tracked-file change${d.modified === 1 ? "" : "s"}`);
    }
    if (d.untracked > 0) {
      parts.push(`${d.untracked} untracked entr${d.untracked === 1 ? "y" : "ies"}`);
    }
    warnings.push(
      `${d.hostPath}: uncommitted changes in session clone (${parts.join(", ")}).`,
    );
  }
  for (const sf of scanFailedRepos) {
    warnings.push(
      `${sf.hostPath}: could not scan session clone (git error: \`${sf.error}\`).`,
    );
    warnings.push(`State is unknown. Session preserved out of caution.`);
  }
  for (const o of orphanRepos) {
    const desc = o.branches
      .map((b) => `\`${b.branch}\` (+${b.count})`)
      .join(", ");
    warnings.push(
      `${o.hostPath}: ${o.branches.length === 1 ? "local branch" : "local branches"} ${desc} not on origin.`,
    );
  }

  // "Your work is at" path block. Enumerate every triggered repo's clone
  // path (deduped — a repo can legitimately be both dirty and have an
  // orphan branch; one entry per unique clone).
  const seen = new Set<string>();
  const clones: string[] = [];
  for (const d of dirtyRepos) {
    if (!seen.has(d.sessionClone)) {
      seen.add(d.sessionClone);
      clones.push(d.sessionClone);
    }
  }
  for (const sf of scanFailedRepos) {
    if (!seen.has(sf.sessionClone)) {
      seen.add(sf.sessionClone);
      clones.push(sf.sessionClone);
    }
  }
  for (const o of orphanRepos) {
    if (!seen.has(o.sessionClone)) {
      seen.add(o.sessionClone);
      clones.push(o.sessionClone);
    }
  }
  if (clones.length > 0) {
    warnings.push("Your uncommitted work is at:");
    for (const c of clones) warnings.push(`  ${c}`);
  }
  warnings.push("");

  // Guidance section — three shapes.
  if (hasOrphan && (dirtyRepos.length > 0 || scanFailedRepos.length > 0)) {
    // Combined: omit discard hint.
    warnings.push(
      `This session has BOTH uncommitted work AND committed work on side branches.`,
    );
    warnings.push(
      `Inspect and rescue both before running \`ccairgap discard ${id}\` —`,
    );
    warnings.push(
      `discard is unsafe until side-branch commits have been preserved.`,
    );
  } else if (scanFailedRepos.length > 0 && dirtyRepos.length === 0) {
    // Scan-failed alone.
    warnings.push(`Inspect manually at:`);
    warnings.push(`  ${scanFailedRepos[0]!.sessionClone}`);
    warnings.push("");
    warnings.push(`If there is nothing to rescue: ccairgap discard ${id}`);
  } else {
    // Dirty-only (or dirty + scan-failed + no orphan — still safe to discard).
    warnings.push(`To save the work:`);
    warnings.push(`  cd <path above>`);
    warnings.push(`  git status                    # see what's there`);
    warnings.push(`  git add -A && git commit      # commit what you want`);
    warnings.push(`  ccairgap recover ${id}`);
    warnings.push("");
    warnings.push(`To drop the work: ccairgap discard ${id}`);
    warnings.push("");
    warnings.push(
      `If this preservation is unintended (e.g. build artifacts from`,
    );
    warnings.push(
      `\`npm install\` / \`pytest\` / etc.), the fix is to add those paths`,
    );
    warnings.push(
      `to your repo's .gitignore. Scripted callers can pass`,
    );
    warnings.push(`--no-preserve-dirty to skip this check entirely.`);
  }
}
