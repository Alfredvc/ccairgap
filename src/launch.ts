import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execa } from "execa";
import {
  encodeCwd,
  hostClaudeDir,
  hostClaudeJson,
  outputDir as outputDirPath,
  realpath,
  sessionDir as sessionDirFn,
  sessionsDir as sessionsDirFn,
} from "./paths.js";
import { writeManifest, type Manifest } from "./manifest.js";
import {
  gitCheckoutNewBranch,
  gitCloneShared,
  readHostGitIdentity,
  resolveGitDir,
} from "./git.js";
import { generateId, listAllContainerNames } from "./sessionId.js";
import { discoverLocalMarketplaces } from "./plugins.js";
import { filterSubsumedMarketplaces } from "./marketplaces.js";
import { buildMounts, mountArg, type Mount } from "./mounts.js";
import { ensureImage, defaultDockerfile, hostClaudeVersion } from "./image.js";
import { handoff } from "./handoff.js";
import { cliVersion } from "./version.js";
import { scanOrphans } from "./orphans.js";
import { resolveCredentials } from "./credentials.js";
import { pointLfsAtHost, writeAlternates } from "./alternates.js";
import { alternatesName } from "./alternatesName.js";
import { executeCopies, resolveArtifacts } from "./artifacts.js";
import { overlayProjectClaudeConfig } from "./projectClaudeOverlay.js";
import { applyHookPolicy } from "./hooks.js";
import { applyMcpPolicy } from "./mcp.js";
import { requireHostBinaries } from "./binaries.js";
import {
  formatDangerWarnings,
  parseDockerRunArgs,
  scanDangerousArgs,
} from "./dockerRunArgs.js";
import { resolveResumeSource, copyResumeTranscript, type ResolvedResumeSource } from "./resume.js";
import { resolveResumeArg, listProjectSessions } from "./resumeResolver.js";
import { detectAndSetupClipboardBridge } from "./clipboardBridge.js";

export interface LaunchOptions {
  repos: string[];
  ros: string[];
  cp: string[];
  sync: string[];
  mount: string[];
  base?: string;
  keepContainer: boolean;
  dockerfile?: string;
  dockerBuildArgs: Record<string, string>;
  rebuild: boolean;
  /** If set, container runs `claude -p "<prompt>"` instead of interactive REPL. */
  print?: string;
  /**
   * User-supplied prefix for the session id. If set, the final id becomes
   * `<name>-<4hex>`; otherwise a random `<adj>-<noun>-<4hex>` is generated.
   * The id drives the session dir, container name (`ccairgap-<id>`), branch
   * (`ccairgap/<id>`), and Claude's session label (`claude -n "ccairgap <id>"`,
   * rewritten to `[ccairgap] <id>` by the rename hook on first prompt).
   */
  name?: string;
  /**
   * Globs matched against each hook's raw `command` string to opt it back in.
   * Empty → every hook source overlaid with `hooks: {}` (statusLine survives).
   * Non-empty → user settings + enabled plugin hooks.json + project settings
   * filtered down to surviving entries and overlaid via bind mounts.
   */
  hookEnable: string[];
  /**
   * Globs matched against each MCP server's `name` key to opt it back in.
   * Empty → every `mcpServers` field overlaid with `{}` at every source
   * (`~/.claude.json` user + user-project, `<repo>/.mcp.json`, enabled plugins).
   * Non-empty → filtered to surviving names. Project scope additionally
   * requires host approval state = `approved`; glob match alone isn't enough.
   */
  mcpEnable: string[];
  /**
   * Raw args appended to `docker run` after all built-in args. Each value is
   * shell-split (`-p 8080:8080` → two tokens). Opt-in escape hatch: user can
   * publish ports, add env, override --network, etc. Can weaken isolation.
   */
  dockerRunArgs: string[];
  /** Print a warning when dockerRunArgs contains known-sharp tokens. Default true. */
  warnDockerArgs: boolean;
  /**
   * Bare mode: caller already skipped config-file loading and cwd-as-workspace
   * inference. Here it switches relative --cp/--sync/--mount paths to anchor on
   * process.cwd() instead of repos[0].hostPath.
   */
  bare: boolean;
  /**
   * If set, resume Claude session `<uuid>` inside the sandbox. The CLI
   * locates `~/.claude/projects/<encoded-workspace-cwd>/<uuid>.jsonl` and
   * copies it (plus the optional `<uuid>/` subagents dir) into
   * `$SESSION/transcripts/<encoded>/` before docker runs. Requires a
   * workspace repo; incompatible with `--bare` or ro-only launches.
   */
  resume?: string;
  /**
   * Enable clipboard passthrough (host-side watcher + bridge-dir RO mount).
   * Default: true. Kill switch: `--no-clipboard` / `clipboard: false` in
   * config. No-op under `--print`.
   */
  clipboard: boolean;
  /**
   * Skip the dirty-working-tree preservation check in the exit-trap handoff.
   * Orphan-branch and scan-failure preservation still fire.
   */
  noPreserveDirty: boolean;
}

export interface LaunchResult {
  exitCode: number;
  id: string;
  sessionDir: string;
  imageTag: string;
}

function die(msg: string): never {
  console.error(`ccairgap: ${msg}`);
  process.exit(1);
}


function dedupeResolved(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    try {
      const r = realpath(p);
      if (!seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    } catch {
      // non-existent paths skip silently here; caller should have validated
    }
  }
  return out;
}

/**
 * Validates that `opts.repos` entries resolve to distinct real paths and that
 * no `opts.ros` entry resolves to the same real path as any repo. Uses
 * `realpath()` so a symlinked form of a real path is caught.
 *
 * Preserves the existing UX: if a path does not exist, `realpath()` throws
 * ENOENT — we catch that and rethrow with the same "path does not exist"
 * message the downstream existence checks (`resolveGitDir`, `--ro` existsSync)
 * would produce. The validation order is therefore: existence → real-path
 * equality, not the other way around.
 */
export function validateRepoRoOverlap(
  repos: string[],
  ros: string[],
  resolveRealpath: (p: string) => string,
): void {
  const resolveOr = (label: string, p: string): string => {
    try {
      return resolveRealpath(p);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`${label} path does not exist: ${p}`);
      }
      throw e;
    }
  };

  const repoSet = new Set<string>();
  for (const r of repos) {
    const real = resolveOr("--repo/--extra-repo", r);
    if (repoSet.has(real)) {
      throw new Error(`duplicate repo path in --repo/--extra-repo: ${r} (resolves to ${real})`);
    }
    repoSet.add(real);
  }
  for (const ro of ros) {
    const real = resolveOr("--ro", ro);
    if (repoSet.has(real)) {
      throw new Error(
        `path appears in both repo (--repo/--extra-repo) and --ro: ${ro} (resolves to ${real})`,
      );
    }
  }
}

export async function launch(opts: LaunchOptions): Promise<LaunchResult> {
  const env = process.env;
  const home = env.HOME ?? homedir();

  // ---- Validation phase: no side effects ----

  // Host-binary preflight. Runs before any mkdir / clone / docker call so a
  // missing binary surfaces as a clean error instead of a mid-pipeline
  // execa ENOENT with a partial $SESSION left on disk.
  try {
    await requireHostBinaries(["docker", "git", "rsync", "cp"]);
  } catch (e) {
    die((e as Error).message);
  }

  // repos must be unique; repos + ros may not overlap
  try {
    validateRepoRoOverlap(opts.repos, opts.ros, realpath);
  } catch (e) {
    die((e as Error).message);
  }

  // Resume requires a workspace repo: the source transcript lives under
  // ~/.claude/projects/<encoded-cwd>/ and the cwd is the workspace.
  // --bare with no --repo, or ro-only launches, have no cwd anchor.
  if (opts.resume !== undefined && opts.repos.length === 0) {
    die("--resume requires a workspace repo (--repo or cwd git repo); got --bare or ro-only");
  }

  // Resolved up-front (was previously computed alongside marketplace discovery)
  // so the resume validation step below can reference it without re-resolving.
  // Both `hostClaudeDir(env)` and `realpath()` are pure — relocation is safe.
  const hostClaude = realpath(hostClaudeDir(env));

  // Session id is computed below after repoPlans is built — generateId reuses
  // the workspace repo's realpath result rather than re-running realpath here.
  let id: string;
  let sessionPath: string;
  let branch: string;

  // Resolve every repo's real git dir upfront so failure aborts before any writes.
  // Phase 1: resolve each repo's git dir. `sessionClonePath` is filled in
  // after `id` is generated below, because it depends on the session dir.
  type PendingRepo = {
    basename: string;
    hostPath: string;
    realGitDir: string;
    alternatesName: string;
    baseRef?: string;
  };
  const pendingRepos: PendingRepo[] = [];
  for (const hostPathRaw of opts.repos) {
    const hostPath = realpath(hostPathRaw);
    let realGitDir: string;
    try {
      realGitDir = resolveGitDir(hostPath);
    } catch (e) {
      die((e as Error).message);
    }
    const bn = basename(hostPath);
    pendingRepos.push({
      basename: bn,
      hostPath,
      realGitDir,
      alternatesName: alternatesName(bn, hostPath),
      baseRef: opts.base,
    });
  }

  // Resolve resume source in the validation phase: if the transcript is
  // missing, die() now so exit 1 happens before any session-dir creation.
  // `opts.resume` may be a UUID or a custom title — resolveResumeArg maps
  // names to UUIDs via transcript-dir scan, UUIDs pass through.
  let resumeSource: ResolvedResumeSource | undefined;
  let resumeUuid: string | undefined;
  if (opts.resume !== undefined) {
    const workspace = pendingRepos[0]?.hostPath;
    if (workspace === undefined) {
      // Unreachable: guard above already die'd when repos.length === 0.
      die("--resume requires a workspace repo");
    }
    try {
      const resolved = await resolveResumeArg({
        hostClaudeDir: hostClaude,
        workspaceHostPath: workspace,
        arg: opts.resume,
      });
      resumeUuid = resolved.uuid;
      resumeSource = resolveResumeSource({
        hostClaudeDir: hostClaude,
        workspaceHostPath: workspace,
        uuid: resumeUuid,
      });
    } catch (e) {
      die((e as Error).message);
    }
  }

  // Session id = `<prefix>-<4hex>`. Prefix is `opts.name` if set, else random
  // `<adj>-<noun>`. Retries on collision with an existing session dir, docker
  // container (running or stopped), or branch in the workspace repo.
  // repoPlans[0].hostPath is already realpath'd; reuse it so no extra syscall
  // and the ordering of error messages (missing-git-repo before docker probe)
  // stays the same as pre-rename.
  try {
    const gen = await generateId({
      userPrefix: opts.name,
      workspaceRepo: pendingRepos[0]?.hostPath,
      runningContainers: await listAllContainerNames(),
      env,
    });
    id = gen.id;
  } catch (e) {
    die((e as Error).message);
  }
  sessionPath = sessionDirFn(id, env);
  branch = `ccairgap/${id}`;

  // Phase 2: attach session clone paths now that `id` (and so `sessionPath`) exists.
  // Uses `alternatesName` (not raw basename) so two repos sharing a basename
  // do not overwrite each other's clone under $SESSION/repos/.
  type RepoPlan = PendingRepo & { sessionClonePath: string };
  const repoPlans: RepoPlan[] = pendingRepos.map((r) => ({
    ...r,
    sessionClonePath: join(sessionPath, "repos", r.alternatesName),
  }));

  // --ro paths must exist.
  const roResolved = dedupeResolved(opts.ros);
  for (const r of roResolved) {
    if (!existsSync(r)) die(`--ro path does not exist: ${r}`);
  }

  // Discover and pre-filter plugin marketplaces.
  // Filtering subsumed-by-repo marketplaces BEFORE resolveArtifacts is
  // critical — resolveArtifacts's overlap check would otherwise fatal on the
  // marketplace-equals-workspace-repo case instead of letting it pass through
  // as a warn-and-drop.
  const rawMarketplaces = discoverLocalMarketplaces(hostClaude, home);
  const marketplaceFilter = filterSubsumedMarketplaces(
    rawMarketplaces,
    repoPlans.map((r) => r.hostPath),
  );
  for (const w of marketplaceFilter.warnings) console.error(`ccairgap: ${w}`);
  const marketplaces = marketplaceFilter.marketplaces;

  // Resolve cp/sync/mount: validate, detect overlaps, plan copies & mounts.
  let artifacts;
  try {
    artifacts = resolveArtifacts({
      cp: opts.cp,
      sync: opts.sync,
      mount: opts.mount,
      repos: repoPlans.map((r) => ({
        basename: r.basename,
        hostPath: r.hostPath,
        sessionClonePath: r.sessionClonePath,
      })),
      roPaths: roResolved,
      marketplaces,
      sessionDir: sessionPath,
      relativeAnchor: opts.bare ? process.cwd() : undefined,
    });
  } catch (e) {
    die((e as Error).message);
  }
  for (const w of artifacts.warnings) console.error(`ccairgap: ${w}`);

  // ---- Orphan scan (advisory only) ----
  const orphans = await scanOrphans(cliVersion());
  if (orphans.length > 0) {
    console.error("ccairgap: orphaned sessions detected:");
    for (const o of orphans) {
      console.error(`  ${o.id}  repos=${o.repos.join(",") || "(none)"}`);
    }
    console.error("  Recover: ccairgap recover <id>");
    console.error("  Discard: ccairgap discard <id>");
    console.error("");
  }

  // ---- Side-effect phase: create session dir, on any failure rm -rf it ----
  mkdirSync(join(sessionPath, "repos"), { recursive: true });
  mkdirSync(join(sessionPath, "transcripts"), { recursive: true });
  mkdirSync(outputDirPath(env), { recursive: true });

  let setupOk = false;
  let creds: Awaited<ReturnType<typeof resolveCredentials>>;
  const repoEntries: RepoPlan[] = [];
  try {
    // Resume: pre-populate $SESSION/transcripts/<encoded>/<uuid>.jsonl (plus
    // optional subagents dir) from the host's ~/.claude/projects/ so
    // `claude -r <uuid>` inside the container finds the transcript. The
    // source existence check ran in the validation phase above — any I/O
    // failure here is a filesystem-level problem worth aborting on, and the
    // setupOk/finally block will rm-rf $SESSION.
    if (resumeSource !== undefined) {
      copyResumeTranscript({
        sessionDir: sessionPath,
        source: resumeSource,
      });
    }

    creds = await resolveCredentials(sessionPath);

    for (const plan of repoPlans) {
      const clonePath = plan.sessionClonePath;
      await gitCloneShared(plan.hostPath, clonePath);
      await gitCheckoutNewBranch(clonePath, branch, opts.base);

      // Point alternates at the container-side mount so the container can
      // commit into its own objects dir without colliding with the RO host
      // mount.
      writeAlternates(clonePath, `/host-git-alternates/${plan.alternatesName}/objects`);

      if (existsSync(join(plan.realGitDir, "lfs", "objects"))) {
        pointLfsAtHost(clonePath, `/host-git-alternates/${plan.alternatesName}/lfs/objects`);
      }

      // Project-scope Claude config overlay: copy host working-tree
      // .claude/, .mcp.json, CLAUDE.md into the session clone so
      // uncommitted / gitignored settings, skills, commands, agents, and
      // MCP config reach the container. These three paths are excluded from
      // the exit-time dirty-tree scan (see `dirtyTree`); overlay noise must
      // not trigger preserve.
      await overlayProjectClaudeConfig({
        hostPath: plan.hostPath,
        clonePath,
      });

      repoEntries.push(plan);
    }

    // Pre-launch copy for --cp and --sync. Must run after clones so in-repo
    // copies land in (or overwrite) the cloned working tree.
    await executeCopies(artifacts.entries);

    setupOk = true;
  } finally {
    if (!setupOk) {
      try {
        rmSync(sessionPath, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
  }

  // Step 7: image
  const dockerfilePath = opts.dockerfile ?? defaultDockerfile();
  const defaultClaudeVersion = opts.dockerBuildArgs.CLAUDE_CODE_VERSION ?? (await hostClaudeVersion()) ?? "latest";
  const buildArgs: Record<string, string> = {
    HOST_UID: String(process.getuid?.() ?? 1000),
    HOST_GID: String(process.getgid?.() ?? 1000),
    CLAUDE_CODE_VERSION: defaultClaudeVersion,
    ...opts.dockerBuildArgs,
  };
  const image = await ensureImage({
    dockerfile: dockerfilePath,
    buildArgs,
    rebuild: opts.rebuild,
  });

  // Step 8: manifest
  const manifest: Manifest = {
    version: 1,
    cli_version: cliVersion(),
    image_tag: image.tag,
    created_at: new Date().toISOString(),
    repos: repoEntries.map((r) => ({
      basename: r.basename,
      host_path: r.hostPath,
      base_ref: r.baseRef,
      alternates_name: r.alternatesName,
    })),
    branch,
    sync: artifacts.syncRecords,
    claude_code: {
      host_version: await hostClaudeVersion(),
    },
  };
  writeManifest(sessionPath, manifest);

  // Step 9: mounts
  const transcriptsDir = join(sessionPath, "transcripts");
  const pluginsCache = join(hostClaude, "plugins", "cache");
  const homeInContainer = "/home/claude";
  const pluginsCacheContainerPath = join(homeInContainer, ".claude", "plugins", "cache");

  // Hook policy: every hook source overlaid via nested single-file binds (user
  // settings, each enabled plugin's hooks.json, each repo's .claude/settings.json
  // [.local]). Empty enable list → filtered = {} so every hook is neutralized.
  // Non-empty → filtered to surviving entries. `disableAllHooks: false` is forced
  // either way so the user's custom statusLine keeps running.
  const hookPolicyResult = applyHookPolicy({
    policy: { enableGlobs: opts.hookEnable },
    sessionDir: sessionPath,
    hostClaudeDir: hostClaude,
    pluginsCacheDir: pluginsCache,
    pluginsCacheContainerPath,
    repos: repoEntries.map((r) => ({
      basename: r.basename,
      sessionClonePath: r.sessionClonePath,
      hostPath: r.hostPath,
      alternatesName: r.alternatesName,
    })),
  });

  // MCP policy: same overlay pattern as hooks. `~/.claude.json` (user + every
  // user-project `mcpServers`) produces one patched copy at
  // `/host-claude-patched-json`. Plugin `.mcp.json` / `plugin.json` and per-repo
  // `<repo>/.mcp.json` get per-file bind overlays. Project scope additionally
  // requires host approval state (`enabledMcpjsonServers` /
  // `enableAllProjectMcpServers`, absent a `disabledMcpjsonServers` entry) —
  // the approval dialog is unreachable inside the airgap container.
  const resolvedClaudeJson = realpath(hostClaudeJson(env));
  const mcpPolicyResult = applyMcpPolicy({
    policy: { enableGlobs: opts.mcpEnable },
    sessionDir: sessionPath,
    hostClaudeDir: hostClaude,
    hostClaudeJsonPath: resolvedClaudeJson,
    pluginsCacheDir: pluginsCache,
    pluginsCacheContainerPath,
    repos: repoEntries.map((r) => ({
      basename: r.basename,
      sessionClonePath: r.sessionClonePath,
      hostPath: r.hostPath,
      alternatesName: r.alternatesName,
    })),
  });

  // Clipboard passthrough (v2): host-side watcher writes
  // $SESSION/clipboard-bridge/current.png; container RO-mounts that directory
  // at /run/ccairgap-clipboard and reads via the entrypoint's fake wl-paste
  // shim. Disabled under --print (non-interactive has no paste UX).
  const clipboard = await detectAndSetupClipboardBridge(sessionPath, {
    enabled: opts.clipboard && opts.print === undefined,
  });

  let mounts: Mount[];
  try {
    mounts = buildMounts({
      hostClaudeDir: hostClaude,
      hostClaudeJson: resolvedClaudeJson,
      hostCredsFile: creds.hostPath,
      hostPatchedUserSettings: hookPolicyResult.patchedUserSettingsPath,
      hostPatchedClaudeJson: mcpPolicyResult.patchedClaudeJsonPath,
      pluginsCacheDir: pluginsCache,
      sessionTranscriptsDir: transcriptsDir,
      outputDir: outputDirPath(env),
      repos: repoEntries,
      roPaths: roResolved,
      pluginMarketplaces: marketplaces,
      homeInContainer,
      // --cp abs-source, --sync abs-source, --mount all bind RW. Hook- and
      // MCP-policy overrides are nested single-file overlays (RO) on top of the
      // plugin cache and session clones. Appended AFTER repo/plugin-cache mounts
      // so overlapping paths win — the overlay is the later mount.
      extraMounts: [
        ...artifacts.extraMounts,
        ...hookPolicyResult.overrideMounts,
        ...mcpPolicyResult.overrideMounts,
        ...clipboard.mounts,
      ],
    });
  } catch (e) {
    die((e as Error).message);
  }

  // Step 10: docker run args
  const containerCwd =
    repoEntries.length > 0 ? (repoEntries[0] as (typeof repoEntries)[number]).hostPath : "/workspace";
  const trustedCwds = repoEntries.map((r) => r.hostPath).join("\n");

  // Git identity: read from first repo (local > global precedence). Fallback so
  // commits always succeed; user rewrites author post-hoc if the fallback leaked in.
  const identityCwd = repoEntries[0]?.hostPath ?? process.cwd();
  const hostIdentity = await readHostGitIdentity(identityCwd);
  if (!hostIdentity.name || !hostIdentity.email) {
    console.error(
      `ccairgap: no git user.${!hostIdentity.name ? "name" : "email"} on host; using fallback "ccairgap <noreply@ccairgap.local>". Rewrite authors on ${branch} if needed.`,
    );
  }
  const gitUserName = hostIdentity.name ?? "ccairgap";
  const gitUserEmail = hostIdentity.email ?? "noreply@ccairgap.local";

  const dockerArgs: string[] = ["run"];
  if (!opts.keepContainer) dockerArgs.push("--rm");
  // Interactive REPL needs -it; print mode is non-interactive so use -i only so output pipes cleanly.
  dockerArgs.push(opts.print ? "-i" : "-it");
  dockerArgs.push("--cap-drop=ALL", "--security-opt=no-new-privileges", "--name", `ccairgap-${id}`);
  dockerArgs.push("-e", `CCAIRGAP_CWD=${containerCwd}`);
  dockerArgs.push("-e", `CCAIRGAP_TRUSTED_CWDS=${trustedCwds}`);
  dockerArgs.push("-e", `CCAIRGAP_GIT_USER_NAME=${gitUserName}`);
  dockerArgs.push("-e", `CCAIRGAP_GIT_USER_EMAIL=${gitUserEmail}`);
  dockerArgs.push("-e", "COLORTERM=truecolor");
  // Match host timezone inside the container. IANA name from the host's ICU
  // data; tzdata in the image makes it resolvable. Falls back silently if the
  // host runtime has no IANA zone (small-icu returns "UTC" — harmless).
  const hostTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (hostTz) dockerArgs.push("-e", `TZ=${hostTz}`);
  if (opts.print !== undefined) {
    dockerArgs.push("-e", `CCAIRGAP_PRINT=${opts.print}`);
  }
  // CCAIRGAP_NAME = the session id (always). The entrypoint builds
  // `claude -n "ccairgap $CCAIRGAP_NAME"` and the UserPromptSubmit rename hook
  // emits `[ccairgap] $CCAIRGAP_NAME`; the two strings differ so Claude's
  // hook-dedup fires and the TUI rename paints. --name only affects the id's
  // prefix (handled in generateId), not this env var.
  dockerArgs.push("-e", `CCAIRGAP_NAME=${id}`);
  // Resume: entrypoint appends `-r "$CCAIRGAP_RESUME"` to the claude exec.
  // Always pass the resolved UUID — claude -r accepts both UUID and title,
  // but we've already copied <uuid>.jsonl into transcripts/, so the UUID
  // form is the only one guaranteed to resolve inside the container.
  if (resumeUuid !== undefined) {
    dockerArgs.push("-e", `CCAIRGAP_RESUME=${resumeUuid}`);
  }
  for (const [k, v] of Object.entries(clipboard.envVars)) {
    dockerArgs.push("-e", `${k}=${v}`);
  }
  for (const m of mounts) dockerArgs.push(...mountArg(m));

  // User-supplied docker run args. Appended last so Docker's last-wins
  // semantics let them override built-ins (e.g. --cap-drop, --network).
  let extraDockerTokens: string[] = [];
  try {
    extraDockerTokens = parseDockerRunArgs(opts.dockerRunArgs);
  } catch (e) {
    die((e as Error).message);
  }
  if (opts.warnDockerArgs) {
    const hits = scanDangerousArgs(extraDockerTokens);
    for (const line of formatDangerWarnings(hits)) console.error(line);
  }
  dockerArgs.push(...extraDockerTokens);

  dockerArgs.push(image.tag);

  // Step 11: exec docker run with exit-trap handoff
  let exitCode = 0;
  try {
    const result = await execa("docker", dockerArgs, {
      stdio: "inherit",
      reject: false,
    });
    exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
  } finally {
    await clipboard.cleanup();

    // Resume hint: scan $SESSION/transcripts/<encoded>/ for the newest jsonl
    // and print its UUID + customTitle. Claude names files by the session
    // UUID it assigns on first message — the ccairgap <id> is NOT that UUID,
    // so users need this hint to re-enter. Best-effort; silent on failure.
    const workspaceRepo = repoEntries[0]?.hostPath;
    let resumeHint: { uuid: string; customTitle?: string } | undefined;
    if (workspaceRepo !== undefined) {
      const encoded = encodeCwd(workspaceRepo);
      const transcriptsProjectDir = join(sessionPath, "transcripts", encoded);
      const candidates = await listProjectSessions(transcriptsProjectDir);
      if (candidates.length > 0) {
        candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
        const newest = candidates[0]!;
        resumeHint = { uuid: newest.uuid, customTitle: newest.customTitle };
      }
    }

    try {
      await handoff(sessionPath, cliVersion(), undefined, {
        noPreserveDirty: opts.noPreserveDirty,
      });
    } catch (e) {
      console.error(`ccairgap: handoff failed: ${(e as Error).message}`);
      console.error(`  Recover manually: ccairgap recover ${id}`);
    }

    if (resumeHint) {
      const titleSuffix = resumeHint.customTitle ? `    # ${resumeHint.customTitle}` : "";
      console.error(`ccairgap: resume this session with:`);
      console.error(`  ccairgap --resume ${resumeHint.uuid}${titleSuffix}`);
      if (resumeHint.customTitle) {
        console.error(`  ccairgap --resume '${resumeHint.customTitle}'`);
      }
    }
  }

  return { exitCode, id, sessionDir: sessionPath, imageTag: image.tag };
}

// Re-export sessionsDir for CLI convenience
export { sessionsDirFn as sessionsDir };
