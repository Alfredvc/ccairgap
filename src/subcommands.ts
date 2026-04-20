import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { execa, execaSync } from "execa";
import {
  hostClaudeDir as hostClaudeDirFn,
  hostClaudeJson as hostClaudeJsonFn,
  realpath,
  sessionDir as sessionDirFn,
  sessionsDir,
  stateRoot,
} from "./paths.js";
import { handoff } from "./handoff.js";
import { scanOrphans } from "./orphans.js";
import { cliVersion } from "./version.js";
import {
  defaultDockerfile,
  defaultEntrypoint,
  computeTag,
  imageExistsLocally,
} from "./image.js";
import { probeCredentials } from "./credentials.js";
import { checkHostBinary } from "./binaries.js";
import { enumerateHooks } from "./hooks.js";
import { enumerateMcpServers } from "./mcp.js";
import { enumerateEnv, enumerateMarketplaces } from "./settings.js";
import { formatInspectPretty } from "./inspectFormat.js";
import { detectClipboardMode, isWsl2, hasCommand } from "./clipboardBridge.js";
import { runningContainerNames } from "./sessionId.js";

/**
 * Return true if a container named `ccairgap-<id>` is currently running.
 * Delegates to the shared `runningContainerNames()` in sessionId.ts so
 * `recover`'s live-check uses the same probe shape as `ccairgap list`.
 */
export async function isSessionContainerLive(id: string): Promise<boolean> {
  const names = await runningContainerNames();
  return names.has(`ccairgap-${id}`);
}

export async function listOrphans(): Promise<void> {
  const orphans = await scanOrphans(cliVersion());
  if (orphans.length === 0) {
    console.log("no orphaned sessions");
    return;
  }
  for (const o of orphans) {
    const commits = Object.entries(o.commits)
      .map(([k, v]) => `${k}+${v}`)
      .join(" ");
    const dirty = Object.entries(o.dirty)
      .map(([k, v]) => `${k}+${v.modified}M/${v.untracked}U`)
      .join(" ");
    const parts = [`${o.id}`, `repos=${o.repos.join(",") || "(none)"}`];
    if (commits) parts.push(`commits=${commits}`);
    if (dirty) parts.push(`dirty=${dirty}`);
    console.log(parts.join("  "));
  }
}

export async function recover(id?: string): Promise<void> {
  if (!id) return listOrphans();
  const sd = sessionDirFn(id);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  if (await isSessionContainerLive(id)) {
    console.error(`ccairgap: session ${id} has a running container (ccairgap-${id}).`);
    console.error(`  Stop it first: docker stop ccairgap-${id}`);
    console.error(`  Or let it exit normally — the exit trap will run handoff.`);
    process.exit(1);
  }
  const result = await handoff(sd, cliVersion());
  const counts = { fetched: 0, empty: 0, failed: 0 };
  for (const f of result.fetched) counts[f.status]++;
  console.log(
    `recovered ${id}: ${counts.fetched} fetched, ${counts.empty} empty, ${counts.failed} failed, ` +
      `${result.transcriptsCopied} transcript dirs copied, ` +
      `session dir ${result.removed ? "removed" : result.preserved ? "preserved" : "kept"}`,
  );
  if (result.warnings.length > 0) process.exitCode = 1;
}

export function discard(id: string): void {
  const sd = sessionDirFn(id);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  rmSync(sd, { recursive: true, force: true });
  console.log(`discarded ${id}`);
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  /** Render as `[WARN]` instead of `[OK]`; still does not fail the run. */
  warn?: boolean;
}

async function checkDocker(): Promise<DoctorCheck> {
  try {
    await execa("docker", ["version", "--format", "{{.Server.Version}}"], { timeout: 5_000 });
    return { name: "docker", ok: true, detail: "running" };
  } catch (e) {
    return { name: "docker", ok: false, detail: (e as Error).message.split("\n")[0] ?? "not running" };
  }
}

async function checkCredentials(): Promise<DoctorCheck> {
  const r = await probeCredentials();
  if (!r.ok) return { name: "host credentials", ok: false, detail: r.detail };
  const parts = [r.detail];
  if (r.ttlMs !== undefined) {
    const mins = Math.max(0, Math.round(r.ttlMs / 60_000));
    parts.push(`ttl=${mins}m`);
  }
  if (r.scopes && r.scopes.length > 0) {
    parts.push(`scopes=${r.scopes.join(" ")}`);
  }
  return { name: "host credentials", ok: true, detail: parts.join("; ") };
}

function checkStateDir(): DoctorCheck {
  const root = stateRoot();
  try {
    mkdirSync(root, { recursive: true });
    const probe = join(root, ".doctor-probe");
    writeFileSync(probe, "");
    unlinkSync(probe);
    return { name: "state dir", ok: true, detail: `${root} (writable)` };
  } catch (e) {
    return { name: "state dir", ok: false, detail: `${root}: ${(e as Error).message}` };
  }
}

async function checkImage(): Promise<DoctorCheck> {
  try {
    const tag = computeTag(defaultDockerfile(), defaultDockerfile());
    const present = await imageExistsLocally(tag);
    if (!present) return { name: "image", ok: false, detail: `${tag} not built yet (first run will build)` };
    const { stdout } = await execa("docker", ["image", "inspect", tag, "--format", "{{.Created}}"]);
    const createdAt = new Date(stdout.trim());
    const ageDays = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60 * 24);
    const stale = ageDays > 14;
    const staleTags = await listStaleDefaultTags(tag);
    const parts = [`${tag} age=${ageDays.toFixed(1)}d`];
    if (stale) parts.push("(stale, consider --rebuild)");
    if (staleTags.length > 0) {
      parts.push(
        `; ${staleTags.length} older ccairgap:${cliVersion()}-* tag(s) present — ` +
          `prune with \`docker image rm ${staleTags.join(" ")}\``,
      );
    }
    return { name: "image", ok: !stale, warn: staleTags.length > 0 && !stale, detail: parts.join(" ") };
  } catch (e) {
    return { name: "image", ok: false, detail: (e as Error).message };
  }
}

/**
 * List `ccairgap:<cli-version>-*` tags other than `currentTag`. The content
 * hash suffix was added so entrypoint/Dockerfile edits produce a new tag;
 * older hashes for the same CLI version are stale. Best-effort — empty on
 * any docker error.
 */
async function listStaleDefaultTags(currentTag: string): Promise<string[]> {
  try {
    const prefix = `ccairgap:${cliVersion()}-`;
    const { stdout } = await execa("docker", [
      "image",
      "ls",
      "--format",
      "{{.Repository}}:{{.Tag}}",
      "ccairgap",
    ]);
    return stdout
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(prefix) && s !== currentTag);
  } catch {
    return [];
  }
}

function checkSessions(): DoctorCheck {
  const d = sessionsDir();
  if (!existsSync(d)) return { name: "sessions dir", ok: true, detail: `${d} (not created yet)` };
  try {
    const entries = statSync(d).isDirectory() ? true : false;
    return { name: "sessions dir", ok: entries, detail: d };
  } catch (e) {
    return { name: "sessions dir", ok: false, detail: (e as Error).message };
  }
}

function checkClipboard(): DoctorCheck {
  const { mode, warning } = detectClipboardMode({
    platform: process.platform,
    env: process.env,
    isWsl2,
    hasCommand,
  });
  if (mode !== "none") {
    const tool = mode === "macos" ? "osascript" : mode === "x11" ? "xclip" : "wl-paste";
    return { name: "clipboard passthrough", ok: true, detail: `${mode} via ${tool}` };
  }
  if (warning) {
    // Strip the "ccairgap: " prefix — doctor renders `[WARN] name: detail` and
    // the prefix would be redundant under our own `name:` column.
    return {
      name: "clipboard passthrough",
      ok: true,
      warn: true,
      detail: warning.replace(/^ccairgap: /, ""),
    };
  }
  return { name: "clipboard passthrough", ok: true, detail: "disabled (unsupported platform)" };
}

/**
 * `ccairgap inspect` — enumerate the full config surface the container would
 * see at launch. Sources walked mirror what the launch pipeline actually reads
 * (user settings, enabled plugins, per-repo project config, `~/.claude.json`).
 * Read-only; no session created. JSON to stdout.
 *
 * Output shape: `{ hooks, mcpServers, env, marketplaces }`. Managed-settings
 * tiers (OS-level policy files, MDM, server-delivered) are intentionally
 * omitted — they aren't mounted into the container.
 */
export function inspectCmd(opts: { repos: string[]; pretty?: boolean }): void {
  const hcd = realpath(hostClaudeDirFn());
  const claudeJsonPath = hostClaudeJsonFn();
  const pluginsCache = join(hcd, "plugins", "cache");
  // realpath only when the path exists — a fresh install with no plugins cache is valid.
  const pluginsCacheResolved = existsSync(pluginsCache) ? realpath(pluginsCache) : pluginsCache;

  const repos = opts.repos.map((p) => {
    const resolved = realpath(p);
    return { basename: basename(resolved), hostPath: resolved };
  });

  const hooks = enumerateHooks({
    hostClaudeDir: hcd,
    pluginsCacheDir: pluginsCacheResolved,
    repos,
  });
  const mcpServers = enumerateMcpServers({
    hostClaudeDir: hcd,
    hostClaudeJsonPath: claudeJsonPath,
    pluginsCacheDir: pluginsCacheResolved,
    repos,
  });
  const env = enumerateEnv({ hostClaudeDir: hcd, repos });
  const marketplaces = enumerateMarketplaces({ hostClaudeDir: hcd, repos });
  if (opts.pretty) {
    console.log(formatInspectPretty({ hooks, mcpServers, env, marketplaces }));
  } else {
    console.log(JSON.stringify({ hooks, mcpServers, env, marketplaces }, null, 2));
  }
}

export async function doctor(): Promise<void> {
  const checks: DoctorCheck[] = [];
  checks.push(await checkDocker());
  checks.push(await checkCredentials());
  checks.push(checkStateDir());
  checks.push(checkSessions());
  checks.push(await checkHostBinary("git"));
  checks.push(await checkHostBinary("rsync"));
  checks.push(await checkHostBinary("cp"));
  checks.push(await checkImage());
  checks.push(checkClipboard());
  const drift = checkSidecarDrift();
  if (drift) checks.push(drift);

  let anyFail = false;
  for (const c of checks) {
    const mark = !c.ok ? "FAIL" : c.warn ? "WARN" : "OK";
    console.log(`[${mark}] ${c.name}: ${c.detail}`);
    if (!c.ok) anyFail = true;
  }

  if (anyFail) process.exitCode = 1;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * Hash-compare sidecar Dockerfile / entrypoint.sh under
 * <git-root>/.ccairgap/ against the bundled copies. Returns undefined
 * when the sidecar dir does not exist (no drift to report). Returns a single
 * check summarizing per-file drift otherwise.
 */
function checkSidecarDrift(): DoctorCheck | undefined {
  let gitRoot: string | undefined;
  try {
    const { stdout, exitCode } = execaSync("git", ["rev-parse", "--show-toplevel"], {
      reject: false,
    });
    if (exitCode === 0 && stdout.trim()) gitRoot = stdout.trim();
  } catch {
    // not in a git repo
  }
  if (!gitRoot) return undefined;
  const sidecarDir = join(gitRoot, ".ccairgap");
  if (!existsSync(sidecarDir)) return undefined;

  const entries: Array<{ name: string; bundled: string }> = [
    { name: "Dockerfile", bundled: defaultDockerfile() },
    { name: "entrypoint.sh", bundled: defaultEntrypoint() },
  ];
  const diverged: string[] = [];
  let anyPresent = false;
  for (const { name, bundled } of entries) {
    const sidecar = join(sidecarDir, name);
    if (!existsSync(sidecar)) continue;
    anyPresent = true;
    if (sha256File(sidecar) !== sha256File(bundled)) diverged.push(name);
  }
  if (!anyPresent) return undefined;
  if (diverged.length === 0) {
    return {
      name: "sidecar docker assets",
      ok: true,
      detail: `${sidecarDir} matches bundled copies`,
    };
  }
  return {
    name: "sidecar docker assets",
    ok: true,
    warn: true,
    detail:
      `${diverged.join(", ")} under ${sidecarDir} diverge from bundled ` +
      `(CLI v${cliVersion()}). Re-run \`ccairgap init --force\` to reset, or ` +
      `keep local edits.`,
  };
}

/** Default config.yaml content written by `ccairgap init`. */
function defaultInitConfigYaml(): string {
  return [
    "# ccairgap config — see README.md §\"Config file\" for all keys.",
    "# Sidecar Dockerfile lives next to this file; the entry below makes",
    "# ccairgap build from it (image tag becomes ccairgap:custom-<hash>).",
    "dockerfile: Dockerfile",
    "",
  ].join("\n");
}

export interface InitOptions {
  /** Explicit --config path, if any. Used to pick the target dir. */
  configPath?: string;
  /** Overwrite existing files. */
  force: boolean;
  /** Override cwd for testing. */
  cwd?: string;
}

/** Resolve the target directory for `ccairgap init`. */
export function resolveInitTarget(opts: InitOptions): string {
  const cwd = opts.cwd ?? process.cwd();
  if (opts.configPath) {
    const abs = isAbsolute(opts.configPath)
      ? opts.configPath
      : resolve(cwd, opts.configPath);
    return dirname(abs);
  }
  try {
    const { stdout, exitCode } = execaSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      reject: false,
    });
    if (exitCode === 0 && stdout.trim()) {
      const gitRoot = stdout.trim();
      const primary = join(gitRoot, ".ccairgap");
      const alternate = join(gitRoot, ".config", "ccairgap");
      // Avoid silently shadowing an existing .config/ccairgap/ config: if the
      // alternate dir already exists and .ccairgap/ does not, target the
      // alternate so init writes where the loader will pick it up first.
      if (existsSync(alternate) && !existsSync(primary)) {
        return alternate;
      }
      return primary;
    }
  } catch {
    // fall through to error
  }
  throw new Error(
    "not in a git repo and no --config passed. " +
      "Pass --config <path> to pick where to materialize the Dockerfile.",
  );
}

/** Write bundled Dockerfile + entrypoint.sh + a minimal config.yaml. */
export function initCmd(opts: InitOptions): void {
  const targetDir = resolveInitTarget(opts);
  const targets = {
    dockerfile: join(targetDir, "Dockerfile"),
    entrypoint: join(targetDir, "entrypoint.sh"),
    config: join(targetDir, "config.yaml"),
  };

  if (!opts.force) {
    const existing = Object.values(targets).filter((p) => existsSync(p));
    if (existing.length > 0) {
      throw new Error(
        `refusing to overwrite existing files:\n  ${existing.join("\n  ")}\n` +
          `Re-run with --force to overwrite all three (destructive; no merge).`,
      );
    }
  }

  mkdirSync(targetDir, { recursive: true });
  copyFileSync(defaultDockerfile(), targets.dockerfile);
  copyFileSync(defaultEntrypoint(), targets.entrypoint);
  writeFileSync(targets.config, defaultInitConfigYaml());

  console.log(`wrote ${targets.dockerfile}`);
  console.log(`wrote ${targets.entrypoint}`);
  console.log(`wrote ${targets.config}`);
  console.log(
    `\nedit ${basename(targets.dockerfile)} to customize; next \`ccairgap\` ` +
      `launch rebuilds as \`ccairgap:custom-<hash>\`.`,
  );
}
