import { existsSync, mkdirSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { execa } from "execa";
import {
  hostClaudeDir as hostClaudeDirFn,
  realpath,
  sessionDir as sessionDirFn,
  sessionsDir,
  stateRoot,
} from "./paths.js";
import { handoff } from "./handoff.js";
import { scanOrphans } from "./orphans.js";
import { cliVersion } from "./version.js";
import { defaultDockerfile, computeTag, imageExistsLocally } from "./image.js";
import { probeCredentials } from "./credentials.js";
import { enumerateHooks } from "./hooks.js";

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
    console.log(`${o.ts}  repos=${o.repos.join(",") || "(none)"}  ${commits}`);
  }
}

export async function recover(ts?: string): Promise<void> {
  if (!ts) return listOrphans();
  const sd = sessionDirFn(ts);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  const result = await handoff(sd, cliVersion());
  const counts = { fetched: 0, empty: 0, failed: 0 };
  for (const f of result.fetched) counts[f.status]++;
  console.log(
    `recovered ${ts}: ${counts.fetched} fetched, ${counts.empty} empty, ${counts.failed} failed, ` +
      `${result.transcriptsCopied} transcript dirs copied, ` +
      `session dir ${result.removed ? "removed" : result.preserved ? "preserved" : "kept"}`,
  );
  if (result.warnings.length > 0) process.exitCode = 1;
}

export function discard(ts: string): void {
  const sd = sessionDirFn(ts);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  rmSync(sd, { recursive: true, force: true });
  console.log(`discarded ${ts}`);
}

interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
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
  return { name: "host credentials", ok: r.ok, detail: r.detail };
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

async function checkHostBinary(name: string): Promise<DoctorCheck> {
  // Use `command -v` (POSIX, works on macOS + Linux without assuming --version
  // support: BSD `cp` has none). Run through sh so the shell builtin is used.
  try {
    const { stdout } = await execa("sh", ["-c", `command -v ${name}`], { timeout: 3_000 });
    return { name, ok: true, detail: stdout.trim() || "found on PATH" };
  } catch {
    return {
      name,
      ok: false,
      detail: "not found on PATH (used for --cp / --sync copies and handoff)",
    };
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
    return {
      name: "image",
      ok: !stale,
      detail: `${tag} age=${ageDays.toFixed(1)}d${stale ? " (stale, consider --rebuild)" : ""}`,
    };
  } catch (e) {
    return { name: "image", ok: false, detail: (e as Error).message };
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

/**
 * `ccairgap hooks` — enumerate hook entries the container would see at launch,
 * across user settings, enabled plugins, and each repo's `.claude/settings.json[.local]`.
 * Read-only; no session created. JSON to stdout.
 */
export function hooksCmd(opts: { repos: string[] }): void {
  const hcd = realpath(hostClaudeDirFn());
  const pluginsCache = join(hcd, "plugins", "cache");
  // realpath only when the path exists — a fresh install with no plugins cache is valid.
  const pluginsCacheResolved = existsSync(pluginsCache) ? realpath(pluginsCache) : pluginsCache;

  const repos = opts.repos.map((p) => {
    const resolved = realpath(p);
    return { basename: basename(resolved), hostPath: resolved };
  });

  const records = enumerateHooks({
    hostClaudeDir: hcd,
    pluginsCacheDir: pluginsCacheResolved,
    repos,
  });
  console.log(JSON.stringify(records, null, 2));
}

export async function doctor(): Promise<void> {
  const checks: DoctorCheck[] = [];
  checks.push(await checkDocker());
  checks.push(await checkCredentials());
  checks.push(checkStateDir());
  checks.push(checkSessions());
  checks.push(await checkHostBinary("rsync"));
  checks.push(await checkHostBinary("cp"));
  checks.push(await checkImage());

  let anyFail = false;
  for (const c of checks) {
    const mark = c.ok ? "OK" : "FAIL";
    console.log(`[${mark}] ${c.name}: ${c.detail}`);
    if (!c.ok) anyFail = true;
  }

  if (anyFail) process.exitCode = 1;
}
