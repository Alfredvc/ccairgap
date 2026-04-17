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
import { gitCheckoutNewBranch, gitCloneShared, resolveGitDir } from "./git.js";
import { discoverLocalMarketplaces } from "./plugins.js";
import { buildMounts, mountArg } from "./mounts.js";
import { ensureImage, defaultDockerfile } from "./image.js";
import { handoff } from "./handoff.js";
import { cliVersion } from "./version.js";
import { scanOrphans } from "./orphans.js";
import { resolveCredentials } from "./credentials.js";
import { pointLfsAtHost, writeAlternates } from "./alternates.js";

export interface LaunchOptions {
  repos: string[];
  ros: string[];
  base?: string;
  keepContainer: boolean;
  dockerfile?: string;
  dockerBuildArgs: Record<string, string>;
  rebuild: boolean;
  /** If set, container runs `claude -p "<prompt>"` instead of interactive REPL. */
  print?: string;
}

export interface LaunchResult {
  exitCode: number;
  ts: string;
  sessionDir: string;
  imageTag: string;
}

function die(msg: string): never {
  console.error(`claude-airlock: ${msg}`);
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

  // repos + ros may not overlap
  const repoSet = new Set(opts.repos.map((p) => resolve(p)));
  for (const ro of opts.ros) {
    if (repoSet.has(resolve(ro))) {
      die(`path appears in both --repo and --ro: ${ro}`);
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
    repoPlans.push({
      basename: basename(hostPath),
      hostPath,
      realGitDir,
      sessionClonePath: "", // filled in once ts is known
      baseRef: opts.base,
    });
  }

  // --ro paths must exist.
  const roResolved = dedupeResolved(opts.ros);
  for (const r of roResolved) {
    if (!existsSync(r)) die(`--ro path does not exist: ${r}`);
  }

  const hostClaude = realpath(hostClaudeDir(env));
  const marketplaces = discoverLocalMarketplaces(hostClaude, home);

  // ---- Orphan scan (advisory only) ----
  const orphans = await scanOrphans(cliVersion());
  if (orphans.length > 0) {
    console.error("claude-airlock: orphaned sessions detected:");
    for (const o of orphans) {
      console.error(`  ${o.ts}  repos=${o.repos.join(",") || "(none)"}`);
    }
    console.error("  Recover: claude-airlock recover <ts>");
    console.error("  Discard: claude-airlock discard <ts>");
    console.error("");
  }

  // ---- Side-effect phase: create session dir, on any failure rm -rf it ----
  const ts = compactTimestamp();
  const sessionPath = sessionDirFn(ts, env);
  mkdirSync(join(sessionPath, "repos"), { recursive: true });
  mkdirSync(join(sessionPath, "transcripts"), { recursive: true });
  mkdirSync(outputDirPath(env), { recursive: true });

  let setupOk = false;
  let creds: Awaited<ReturnType<typeof resolveCredentials>>;
  const repoEntries: RepoPlan[] = [];
  try {
    creds = await resolveCredentials(sessionPath);

    for (const plan of repoPlans) {
      const clonePath = join(sessionPath, "repos", plan.basename);
      await gitCloneShared(plan.hostPath, clonePath);
      await gitCheckoutNewBranch(clonePath, `sandbox/${ts}`, opts.base);

      // Point alternates at the container-side mount so the container can
      // commit into its own objects dir without colliding with the RO host
      // mount.
      writeAlternates(clonePath, `/host-git-alternates/${plan.basename}/objects`);

      if (existsSync(join(plan.realGitDir, "lfs", "objects"))) {
        pointLfsAtHost(clonePath, `/host-git-alternates/${plan.basename}/lfs/objects`);
      }

      repoEntries.push({ ...plan, sessionClonePath: clonePath });
    }
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
    claude_code: {
      host_version: await hostClaudeCodeVersion(),
    },
  };
  writeManifest(sessionPath, manifest);

  // Step 9: mounts
  const transcriptsDir = join(sessionPath, "transcripts");
  const pluginsCache = join(hostClaude, "plugins", "cache");
  const mounts = buildMounts({
    hostClaudeDir: hostClaude,
    hostClaudeJson: realpath(hostClaudeJson(env)),
    hostCredsFile: creds.hostPath,
    pluginsCacheDir: pluginsCache,
    sessionTranscriptsDir: transcriptsDir,
    outputDir: outputDirPath(env),
    repos: repoEntries,
    roPaths: roResolved,
    pluginMarketplaces: marketplaces,
    homeInContainer: "/home/claude",
  });

  // Step 10: docker run args
  const containerCwd =
    repoEntries.length > 0 ? (repoEntries[0] as (typeof repoEntries)[number]).hostPath : "/workspace";
  const trustedCwds = repoEntries.map((r) => r.hostPath).join("\n");

  const dockerArgs: string[] = ["run"];
  if (!opts.keepContainer) dockerArgs.push("--rm");
  // Interactive REPL needs -it; print mode is non-interactive so use -i only so output pipes cleanly.
  dockerArgs.push(opts.print ? "-i" : "-it");
  dockerArgs.push("--cap-drop=ALL", "--name", `claude-airlock-${ts}`);
  dockerArgs.push("-e", `AIRLOCK_CWD=${containerCwd}`);
  dockerArgs.push("-e", `AIRLOCK_TRUSTED_CWDS=${trustedCwds}`);
  if (opts.print !== undefined) {
    dockerArgs.push("-e", `AIRLOCK_PRINT=${opts.print}`);
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
      console.error(`claude-airlock: handoff failed: ${(e as Error).message}`);
      console.error(`  Recover manually: claude-airlock recover ${ts}`);
    }
  }

  return { exitCode, ts, sessionDir: sessionPath, imageTag: image.tag };
}

// Re-export sessionsDir for CLI convenience
export { sessionsDirFn as sessionsDir };
