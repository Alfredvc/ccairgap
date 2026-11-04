import { existsSync, mkdirSync, readdirSync, statSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { readManifest, UnknownManifestVersionError } from "./manifest.js";
import {
  checkRefFormat,
  dirtyTree,
  gitBranchExists,
  gitFetchBranchAs,
  gitFetchSandbox,
} from "./git.js";
import { prepareLinkedWorktrees, type LinkedWorktree } from "./worktrees.js";
import { sanitizeSessionClone } from "./sessionCloneTrust.js";
import { outputDir } from "./paths.js";
import { copyCodexSessions } from "./codexSessions.js";

export type FetchStatus = "fetched" | "empty" | "failed";

export interface HandoffResult {
  sessionDir: string;
  id: string;
  fetched: Array<{ hostPath: string; branch: string; status: FetchStatus }>;
  transcriptsCopied: number;
  codexSessionsCopied: number;
  codexSessionsExisting: number;
  /**
   * Per-file paths (relative to `~/.claude/projects/`) of the transcript
   * jsonl files copied out. Logged via `logger` inline as they're copied
   * so users get visibility into which sessions were rescued.
   */
  transcriptFiles: string[];
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
 * Local branches (other than `exclude`) that carry commits not present on any
 * `origin/*` ref. Used to detect work the user made on side branches when the
 * sandbox branch itself is empty — handoff fetches only ccairgap/<id> and
 * worktree branches, so those commits would be lost on rm -rf.
 */
async function orphanBranches(
  sessionClone: string,
  exclude: ReadonlySet<string>,
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
      .filter((s) => s.length > 0 && !exclude.has(s));
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
 * Commits on a worktree branch that neither `origin/*` nor the sandbox branch
 * holds. Returns null when git cannot count them: the caller must not treat an
 * error as "no work".
 */
async function worktreeBranchAhead(
  sessionClone: string,
  worktreeBranch: string,
  sandboxBranch: string,
): Promise<number | null> {
  const exclusions = ["--remotes=origin"];
  if (await gitBranchExists(sessionClone, sandboxBranch)) {
    exclusions.push(`refs/heads/${sandboxBranch}`);
  }
  try {
    const { stdout } = await execa("git", [
      "-C",
      sessionClone,
      "rev-list",
      "--count",
      `refs/heads/${worktreeBranch}`,
      "--not",
      ...exclusions,
    ]);
    const count = parseInt(stdout.trim(), 10);
    return Number.isNaN(count) ? null : count;
  } catch {
    return null;
  }
}

/**
 * Pre-scan a session dir for dirty (uncommitted) repos and linked worktrees.
 * Used by `recover`'s pre-check so a dirty session aborts before any side
 * effects run. Mirrors the per-repo alternates rewrite + dirtyTree probe in
 * `handoff()` so the scan sees the same state handoff would. Best-effort:
 * missing/unreadable manifest, or a repo whose host path or session clone is
 * gone, is silently skipped — those cases also don't trip handoff's dirty
 * preservation. A worktree preparation failure is skipped here because handoff
 * reports it as a scan failure.
 */
export async function scanDirtyRepos(
  sessionDirPath: string,
  cliVersion: string,
): Promise<Array<{
  hostPath: string;
  sessionClone: string;
  modified: number;
  untracked: number;
}>> {
  const out: Array<{
    hostPath: string;
    sessionClone: string;
    modified: number;
    untracked: number;
  }> = [];
  if (!existsSync(sessionDirPath)) return out;
  let manifest;
  try {
    manifest = readManifest(sessionDirPath, cliVersion);
  } catch {
    return out;
  }
  for (const repo of manifest.repos) {
    const name = repo.alternates_name ?? repo.basename;
    const sessionClone = join(sessionDirPath, "repos", name);
    if (!existsSync(repo.host_path) || !existsSync(sessionClone)) continue;
    try {
      await sanitizeSessionClone({
        sessionDir: sessionDirPath,
        name,
        sessionClone,
        hostPath: repo.host_path,
      });
    } catch {
      // handoff reports this as a scan failure. No host git may run in this clone.
      continue;
    }
    const status = await dirtyTree(sessionClone);
    if (status.kind === "dirty") {
      out.push({
        hostPath: repo.host_path,
        sessionClone,
        modified: status.modified,
        untracked: status.untracked,
      });
    }
    let worktrees: LinkedWorktree[] = [];
    try {
      worktrees = prepareLinkedWorktrees(sessionClone, repo.host_path);
    } catch {
      // handoff reports this as a scan failure
    }
    for (const wt of worktrees) {
      if (wt.path === null) continue;
      const wtStatus = await dirtyTree(wt.path);
      if (wtStatus.kind === "dirty") {
        out.push({
          hostPath: repo.host_path,
          sessionClone: wt.path,
          modified: wtStatus.modified,
          untracked: wtStatus.untracked,
        });
      }
    }
  }
  return out;
}

/**
 * Idempotent handoff for a session dir. Used by both exit trap and `recover`.
 * Fails open: each step runs independently, errors are logged to warnings.
 *
 * Preservation triggers (any one prevents the terminal `rm -rf`):
 *  - dirty working tree in any session clone or linked worktree (skipped if
 *    `noPreserveDirty`)
 *  - dirty scan or worktree preparation failed for any repo (unknown state →
 *    err on preserve)
 *  - a worktree branch could not be delivered to the host
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
  let codexSessionsCopied = 0;
  let codexSessionsExisting = 0;
  const transcriptFiles: string[] = [];
  let removed = false;

  if (!existsSync(sessionDirPath)) {
    warnings.push(`session dir does not exist: ${sessionDirPath}`);
    return {
      sessionDir: sessionDirPath,
      id,
      fetched,
      transcriptsCopied,
      codexSessionsCopied,
      codexSessionsExisting,
      transcriptFiles: [],
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
        codexSessionsCopied,
        codexSessionsExisting,
        transcriptFiles: [],
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
      codexSessionsCopied,
      codexSessionsExisting,
      transcriptFiles: [],
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
    isWorktree: boolean;
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
    const name = repo.alternates_name ?? repo.basename;
    const sessionClone = join(sessionDirPath, "repos", name);
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

    // Rebuild the container-written `.git` before any other host git command.
    // This also points alternates at the real host objects, which dirtyTree()
    // and the fetch below need. On failure no host git may run in this clone.
    try {
      await sanitizeSessionClone({
        sessionDir: sessionDirPath,
        name,
        sessionClone,
        hostPath: repo.host_path,
      });
    } catch (e) {
      scanFailedRepos.push({
        hostPath: repo.host_path,
        sessionClone,
        error: `cannot sanitize session clone: ${(e as Error).message}`,
      });
      fetched.push({ hostPath: repo.host_path, branch, status: "failed" });
      continue;
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
        isWorktree: false,
      });
    } else if (status.kind === "scan-failed") {
      scanFailedRepos.push({
        hostPath: repo.host_path,
        sessionClone,
        error: status.error,
      });
    }

    // Linked worktrees. `dirtyTree` above excludes `.claude/`, which holds
    // `.claude/worktrees/`, and the sandbox fetch below covers only one branch.
    let worktrees: LinkedWorktree[] = [];
    try {
      worktrees = prepareLinkedWorktrees(sessionClone, repo.host_path);
    } catch (e) {
      scanFailedRepos.push({
        hostPath: repo.host_path,
        sessionClone,
        error: (e as Error).message,
      });
    }
    const delivered = new Set<string>([branch]);
    const undelivered: Array<{ branch: string; count: number }> = [];
    for (const wt of worktrees) {
      if (wt.path === null) {
        warnings.push(
          `${repo.host_path}: linked worktree ${wt.recordedPath} was outside the session clone. Its uncommitted files are gone.`,
        );
      } else {
        const wtStatus = await dirtyTree(wt.path);
        if (wtStatus.kind === "dirty" && !opts.noPreserveDirty) {
          dirtyRepos.push({
            hostPath: repo.host_path,
            sessionClone: wt.path,
            modified: wtStatus.modified,
            untracked: wtStatus.untracked,
            isWorktree: true,
          });
        } else if (wtStatus.kind === "scan-failed") {
          scanFailedRepos.push({
            hostPath: repo.host_path,
            sessionClone: wt.path,
            error: wtStatus.error,
          });
        }
      }

      if (wt.branch === null || wt.branch === branch) continue;
      // The container wrote this name, and it goes into a host refspec.
      if (!(await checkRefFormat(`refs/heads/${wt.branch}`))) {
        scanFailedRepos.push({
          hostPath: repo.host_path,
          sessionClone: wt.path ?? sessionClone,
          error: `invalid worktree branch name: ${JSON.stringify(wt.branch)}`,
        });
        continue;
      }
      const ahead = await worktreeBranchAhead(sessionClone, wt.branch, branch);
      if (ahead === null) {
        scanFailedRepos.push({
          hostPath: repo.host_path,
          sessionClone: wt.path ?? sessionClone,
          error: `cannot count commits on worktree branch ${wt.branch}`,
        });
        continue;
      }
      if (ahead === 0) {
        delivered.add(wt.branch);
        continue;
      }
      const target = `${branch}-worktrees/${wt.branch}`;
      const ok = await gitFetchBranchAs(repo.host_path, sessionClone, wt.branch, target);
      fetched.push({
        hostPath: repo.host_path,
        branch: target,
        status: ok ? "fetched" : "failed",
      });
      if (ok) {
        delivered.add(wt.branch);
        logger(`[handoff] worktree branch ${wt.branch} (+${ahead}) is on the host as ${target}`);
      } else {
        warnings.push(`fetch failed for ${repo.host_path} (branch ${wt.branch} to ${target})`);
        undelivered.push({ branch: wt.branch, count: ahead });
      }
    }

    const sandboxCount = await sandboxCommitCount(sessionClone, branch);
    const orphans = [...undelivered];
    if (sandboxCount === 0) {
      const exclude = new Set([...delivered, ...undelivered.map((u) => u.branch)]);
      orphans.push(...(await orphanBranches(sessionClone, exclude)));
    }
    if (orphans.length > 0) {
      orphanRepos.push({
        hostPath: repo.host_path,
        sessionClone,
        branches: orphans,
      });
    }
    if (sandboxCount === 0) {
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

  // Transcripts copy-out. After each successful per-encoded-dir cp, list the
  // main-session UUIDs (top-level `<uuid>.jsonl` files) on a single line.
  // Sidecar dirs (`<uuid>/subagents/...`) are copied but not enumerated —
  // they're noise for the user, who navigates by main session id.
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
        try {
          for (const f of readdirSync(src)) {
            if (!f.endsWith(".jsonl")) continue;
            if (!statSync(join(src, f)).isFile()) continue;
            transcriptFiles.push(join(entry, f));
            logger(`[handoff] session copied: ${f.slice(0, -".jsonl".length)}`);
          }
        } catch {
          // best-effort enumeration — copy already succeeded
        }
      } catch (e) {
        warnings.push(
          `transcript copy failed for ${entry}: ${(e as Error).message}`,
        );
      }
    }
  }

  const codexResult = await copyCodexSessions({
    sessionDir: sessionDirPath,
    manifest,
    protectedHostPaths: [
      ...manifest.repos.map((repo) => repo.host_path),
      ...(manifest.sync ?? []).map((s) => s.src_host),
    ],
  });
  codexSessionsCopied = codexResult.copied;
  codexSessionsExisting = codexResult.existing;
  for (const warning of codexResult.warnings) {
    warnings.push(`Codex session copy-out: ${warning}`);
  }

  const preserved =
    dirtyRepos.length > 0 ||
    orphanRepos.length > 0 ||
    scanFailedRepos.length > 0 ||
    codexResult.status === "preserve";

  if (dirtyRepos.length > 0 || orphanRepos.length > 0 || scanFailedRepos.length > 0) {
    emitPreservationWarnings({
      warnings,
      sessionDirPath,
      id,
      dirtyRepos,
      orphanRepos,
      scanFailedRepos,
    });
  } else if (codexResult.status === "preserve") {
    warnings.push(`Session preserved so Codex rollout files can be inspected manually.`);
    warnings.push(`After resolving the Codex copy-out issue, rerun: ccairgap recover ${id}`);
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
    transcriptFiles,
    codexSessionsCopied,
    codexSessionsExisting,
    removed,
    preserved,
    warnings,
  };
}

/**
 * Format the preservation message into `warnings[]` (one entry per line, so
 * the logger prefix `[handoff] ` lands on each rendered line).
 *
 * Four shapes:
 *  - dirty-only (no orphan, no scan-fail): full discard hint OK.
 *  - orphan-only: `recover` does not deliver these branches, so the guidance
 *    prints the fetch command for each one.
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
    isWorktree: boolean;
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
      `${d.hostPath}: uncommitted changes in ${d.isWorktree ? "linked worktree" : "session clone"} (${parts.join(", ")}).`,
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
    const hasUncommitted = dirtyRepos.length > 0 || scanFailedRepos.length > 0;
    warnings.push(
      hasOrphan
        ? hasUncommitted
          ? "Your work is at:"
          : "Your committed work is at:"
        : "Your uncommitted work is at:",
    );
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
  } else if (hasOrphan && dirtyRepos.length === 0) {
    // Orphan-only: `recover` does not deliver these branches.
    warnings.push(`To save the commits, fetch each branch into the host repo:`);
    for (const o of orphanRepos) {
      for (const b of o.branches) {
        warnings.push(`  git -C ${o.hostPath} fetch ${o.sessionClone} ${b.branch}:${b.branch}`);
      }
    }
    warnings.push("");
    warnings.push(`When you have the commits, or to drop them: ccairgap discard ${id}`);
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
