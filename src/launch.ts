import { existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { execa } from "execa";
import {
  compactTimestamp,
  hostClaudeDir,
  hostClaudeJson,
  outputDir as outputDirPath,
  realpath,
  sessionDir as sessionDirFn,
  sessionsDir as sessionsDirFn,
} from "./paths.js";
import { writeManifest, type Manifest } from "./manifest.js";
import {
  checkRefFormat,
  gitBranchExists,
  gitCheckoutNewBranch,
  gitCloneShared,
  readHostGitIdentity,
  resolveGitDir,
} from "./git.js";
import { discoverLocalMarketplaces } from "./plugins.js";
import { buildMounts, mountArg } from "./mounts.js";
import { ensureImage, defaultDockerfile } from "./image.js";
import { handoff } from "./handoff.js";
import { cliVersion } from "./version.js";
import { scanOrphans } from "./orphans.js";
import { resolveCredentials } from "./credentials.js";
import { pointLfsAtHost, writeAlternates } from "./alternates.js";
import { executeCopies, resolveArtifacts } from "./artifacts.js";
import { applyHookPolicy } from "./hooks.js";

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
  /** If set, sandbox branch becomes `sandbox/<name>` (instead of `sandbox/<ts>`) and is forwarded to `claude -n <name>`. */
  name?: string;
  /**
   * Globs matched against each hook's raw `command` string to opt it back in.
   * Empty → all hooks disabled (top-level `disableAllHooks: true` injected).
   * Non-empty → filter user settings + enabled plugin hooks.json + project
   * settings and overlay the filtered copies via bind mounts.
   */
  hookEnable: string[];
}

export interface LaunchResult {
  exitCode: number;
  ts: string;
  sessionDir: string;
  imageTag: string;
}

function die(msg: string): never {
  console.error(`ccairlock: ${msg}`);
  process.exit(1);
}

async function hostClaudeCodeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execa("claude", ["--version"], { timeout: 5_000 });
    return stdout.trim();
  } catch {
    return undefined;
  }
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

export async function launch(opts: LaunchOptions): Promise<LaunchResult> {
  const env = process.env;
  const home = env.HOME ?? homedir();

  // ---- Validation phase: no side effects ----

  // repos must be unique; repos + ros may not overlap
  const repoSet = new Set<string>();
  for (const r of opts.repos) {
    const abs = resolve(r);
    if (repoSet.has(abs)) {
      die(`duplicate repo path in --repo/--extra-repo: ${r}`);
    }
    repoSet.add(abs);
  }
  for (const ro of opts.ros) {
    if (repoSet.has(resolve(ro))) {
      die(`path appears in both repo (--repo/--extra-repo) and --ro: ${ro}`);
    }
  }

  // Compute ts + session dir paths up-front so we can resolve artifact
  // session-scratch targets before any filesystem side effects.
  const ts = compactTimestamp();
  const sessionPath = sessionDirFn(ts, env);

  // Branch name: `sandbox/<name ?? ts>`. `<ts>` is always well-formed; a user-
  // supplied `<name>` is validated via `git check-ref-format` on the full ref.
  const branchSuffix = opts.name ?? ts;
  const branch = `sandbox/${branchSuffix}`;
  if (opts.name !== undefined) {
    if (!(await checkRefFormat(`refs/heads/${branch}`))) {
      die(`--name "${opts.name}" is not a valid git ref component (branch would be ${branch})`);
    }
  }

  // Resolve every repo's real git dir upfront so failure aborts before any writes.
  type RepoPlan = {
    basename: string;
    hostPath: string;
    realGitDir: string;
    sessionClonePath: string;
    baseRef?: string;
  };
  const repoPlans: RepoPlan[] = [];
  for (const hostPathRaw of opts.repos) {
    const hostPath = realpath(hostPathRaw);
    let realGitDir: string;
    try {
      realGitDir = resolveGitDir(hostPath);
    } catch (e) {
      die((e as Error).message);
    }
    const bn = basename(hostPath);
    repoPlans.push({
      basename: bn,
      hostPath,
      realGitDir,
      sessionClonePath: join(sessionPath, "repos", bn),
      baseRef: opts.base,
    });
  }

  // --ro paths must exist.
  const roResolved = dedupeResolved(opts.ros);
  for (const r of roResolved) {
    if (!existsSync(r)) die(`--ro path does not exist: ${r}`);
  }

  // Branch-collision check (only meaningful when --name is passed; `sandbox/<ts>`
  // is always unique). Check only the workspace repo (repoPlans[0]); extra repos
  // ride along and are left to surface their own collision at fetch time if any.
  if (opts.name !== undefined && repoPlans.length > 0) {
    const workspace = repoPlans[0]!;
    if (await gitBranchExists(workspace.hostPath, branch)) {
      die(
        `branch ${branch} already exists in ${workspace.hostPath}. ` +
          `Pick a different --name or delete the existing branch.`,
      );
    }
  }

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
      sessionDir: sessionPath,
    });
  } catch (e) {
    die((e as Error).message);
  }
  for (const w of artifacts.warnings) console.error(`ccairlock: ${w}`);

  const hostClaude = realpath(hostClaudeDir(env));
  const marketplaces = discoverLocalMarketplaces(hostClaude, home);

  // ---- Orphan scan (advisory only) ----
  const orphans = await scanOrphans(cliVersion());
  if (orphans.length > 0) {
    console.error("ccairlock: orphaned sessions detected:");
    for (const o of orphans) {
      console.error(`  ${o.ts}  repos=${o.repos.join(",") || "(none)"}`);
    }
    console.error("  Recover: ccairlock recover <ts>");
    console.error("  Discard: ccairlock discard <ts>");
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
    creds = await resolveCredentials(sessionPath);

    for (const plan of repoPlans) {
      const clonePath = plan.sessionClonePath;
      await gitCloneShared(plan.hostPath, clonePath);
      await gitCheckoutNewBranch(clonePath, branch, opts.base);

      // Point alternates at the container-side mount so the container can
      // commit into its own objects dir without colliding with the RO host
      // mount.
      writeAlternates(clonePath, `/host-git-alternates/${plan.basename}/objects`);

      if (existsSync(join(plan.realGitDir, "lfs", "objects"))) {
        pointLfsAtHost(clonePath, `/host-git-alternates/${plan.basename}/lfs/objects`);
      }

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
  const buildArgs: Record<string, string> = {
    HOST_UID: String(process.getuid?.() ?? 1000),
    HOST_GID: String(process.getgid?.() ?? 1000),
    CLAUDE_CODE_VERSION: opts.dockerBuildArgs.CLAUDE_CODE_VERSION ?? "latest",
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
    })),
    branch,
    sync: artifacts.syncRecords,
    claude_code: {
      host_version: await hostClaudeCodeVersion(),
    },
  };
  writeManifest(sessionPath, manifest);

  // Step 9: mounts
  const transcriptsDir = join(sessionPath, "transcripts");
  const pluginsCache = join(hostClaude, "plugins", "cache");
  const homeInContainer = "/home/claude";
  const pluginsCacheContainerPath = join(homeInContainer, ".claude", "plugins", "cache");

  // Hook policy: default is disableAllHooks:true; non-empty --hook-enable list
  // produces filtered overlays for user settings, each enabled plugin's hooks.json,
  // and each repo's .claude/settings.json[.local]. Mounts are nested single-file
  // binds that overlay RO mounts (plugin cache) and the RW session clones.
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
    })),
  });

  const mounts = buildMounts({
    hostClaudeDir: hostClaude,
    hostClaudeJson: realpath(hostClaudeJson(env)),
    hostCredsFile: creds.hostPath,
    hostPatchedUserSettings: hookPolicyResult.patchedUserSettingsPath,
    pluginsCacheDir: pluginsCache,
    sessionTranscriptsDir: transcriptsDir,
    outputDir: outputDirPath(env),
    repos: repoEntries,
    roPaths: roResolved,
    pluginMarketplaces: marketplaces,
    homeInContainer,
    // --cp abs-source, --sync abs-source, --mount all bind RW. Hook-policy
    // overrides are nested single-file overlays (RO) on top of the plugin
    // cache and session clones. Appended AFTER repo/plugin-cache mounts so
    // overlapping paths win — the overlay is the later mount.
    extraMounts: [...artifacts.extraMounts, ...hookPolicyResult.overrideMounts],
  });

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
      `ccairlock: no git user.${!hostIdentity.name ? "name" : "email"} on host; using fallback "claude-airlock <noreply@airlock.local>". Rewrite authors on ${branch} if needed.`,
    );
  }
  const gitUserName = hostIdentity.name ?? "claude-airlock";
  const gitUserEmail = hostIdentity.email ?? "noreply@airlock.local";

  const dockerArgs: string[] = ["run"];
  if (!opts.keepContainer) dockerArgs.push("--rm");
  // Interactive REPL needs -it; print mode is non-interactive so use -i only so output pipes cleanly.
  dockerArgs.push(opts.print ? "-i" : "-it");
  dockerArgs.push("--cap-drop=ALL", "--name", `claude-airlock-${ts}`);
  dockerArgs.push("-e", `AIRLOCK_CWD=${containerCwd}`);
  dockerArgs.push("-e", `AIRLOCK_TRUSTED_CWDS=${trustedCwds}`);
  dockerArgs.push("-e", `AIRLOCK_GIT_USER_NAME=${gitUserName}`);
  dockerArgs.push("-e", `AIRLOCK_GIT_USER_EMAIL=${gitUserEmail}`);
  if (opts.print !== undefined) {
    dockerArgs.push("-e", `AIRLOCK_PRINT=${opts.print}`);
  }
  if (opts.name !== undefined) {
    dockerArgs.push("-e", `AIRLOCK_NAME=${opts.name}`);
  }
  for (const m of mounts) dockerArgs.push(...mountArg(m));
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
    try {
      await handoff(sessionPath, cliVersion());
    } catch (e) {
      console.error(`ccairlock: handoff failed: ${(e as Error).message}`);
      console.error(`  Recover manually: ccairlock recover ${ts}`);
    }
  }

  return { exitCode, ts, sessionDir: sessionPath, imageTag: image.tag };
}

// Re-export sessionsDir for CLI convenience
export { sessionsDirFn as sessionsDir };
