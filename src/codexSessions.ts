import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import type { Manifest } from "./manifest.js";
import { requireManifestCodexHostHome } from "./manifest.js";

export type CopyCodexSessionsStatus = "ok" | "preserve";

export interface CopyCodexSessionsOkResult {
  status: "ok";
  copied: number;
  existing: number;
  warnings: string[];
}

export interface CopyCodexSessionsPreserveResult {
  status: "preserve";
  copied: number;
  existing: number;
  warnings: string[];
}

export type CopyCodexSessionsResult =
  | CopyCodexSessionsOkResult
  | CopyCodexSessionsPreserveResult;

export interface CopyCodexSessionsOptions {
  sessionDir: string;
  manifest: Manifest;
  protectedHostPaths?: readonly string[];
  logger?: (message: string) => void;
  beforePublish?: (destination: string) => void | Promise<void>;
}

export async function copyCodexSessions(
  options: CopyCodexSessionsOptions,
): Promise<CopyCodexSessionsResult> {
  try {
    const sourceRoot = join(options.sessionDir, "codex-sessions");
    if (!existsSync(sourceRoot)) return ok(0, 0);

    let hostHome: string;
    try {
      hostHome = requireManifestCodexHostHome(options.manifest);
    } catch (e) {
      return preserve((e as Error).message);
    }

    const preflight = preflightCopy({
      sourceRoot,
      hostHome,
      protectedHostPaths: options.protectedHostPaths ?? [],
    });
    if (preflight.status === "preserve") return preflight;

    let copied = 0;
    let existing = preflight.existing;
    const warnings: string[] = [];
    for (const file of preflight.files) {
      const publish = await publishRollout(file, options.beforePublish);
      copied += publish.copied;
      existing += publish.existing;
      if (publish.status === "preserve") {
        warnings.push(...publish.warnings);
        break;
      }
    }
    const status: CopyCodexSessionsStatus = warnings.length > 0 ? "preserve" : "ok";
    for (const warning of warnings) options.logger?.(warning);
    return { status, copied, existing, warnings };
  } catch (e) {
    return preserve(`Codex sessions scan failed: ${(e as Error).message}`);
  }
}

interface RolloutFile {
  src: string;
  dest: string;
  year: string;
  month: string;
  day: string;
  existing: boolean;
}

type PreflightResult =
  | { status: "ok"; files: RolloutFile[]; existing: number; warnings: string[] }
  | CopyCodexSessionsPreserveResult;

function ok(copied: number, existing: number): CopyCodexSessionsResult {
  return { status: "ok", copied, existing, warnings: [] };
}

function preserve(message: string): CopyCodexSessionsPreserveResult {
  return { status: "preserve", copied: 0, existing: 0, warnings: [message] };
}

function preflightCopy(options: {
  sourceRoot: string;
  hostHome: string;
  protectedHostPaths: readonly string[];
}): PreflightResult {
  const sourceRootStat = safeLstat(options.sourceRoot);
  if (sourceRootStat === undefined) {
    return preserve(`cannot scan Codex sessions: ${options.sourceRoot}`);
  }
  if (sourceRootStat.isSymbolicLink()) {
    return preserve(`Codex sessions source is a symbolic link: ${options.sourceRoot}`);
  }
  if (!sourceRootStat.isDirectory()) {
    return preserve(`Codex sessions source is not a directory: ${options.sourceRoot}`);
  }

  if (!isAbsolute(options.hostHome)) {
    return preserve("manifest codex.host_home must be absolute for Codex session handoff");
  }
  const overlap = findProtectedOverlap(options.hostHome, options.protectedHostPaths);
  if (overlap) {
    return preserve(
      `manifest codex.host_home overlaps protected host path ${overlap}: ${options.hostHome}`,
    );
  }
  const hostHomeWarning = validateExistingPathAncestors(options.hostHome);
  if (hostHomeWarning) return preserve(hostHomeWarning);

  const files: RolloutFile[] = [];
  const sourceWarning = collectRollouts(options.sourceRoot, options.hostHome, files);
  if (sourceWarning) return preserve(sourceWarning);

  let existing = 0;
  for (const file of files) {
    const parentWarning = validateDestinationParents(file.dest, options.hostHome);
    if (parentWarning) return preserve(parentWarning);
    const collision = classifyExistingDestination(file.src, file.dest);
    if (collision.status === "preserve") return collision;
    if (collision.existing > 0) {
      file.existing = true;
      existing += collision.existing;
    }
  }

  return { status: "ok", files, existing, warnings: [] };
}

function safeLstat(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function collectRollouts(sourceRoot: string, hostHome: string, out: RolloutFile[]): string | undefined {
  for (const year of sortedEntries(sourceRoot)) {
    if (!/^\d{4}$/.test(year)) return `unexpected Codex sessions entry: ${join(sourceRoot, year)}`;
    const yearPath = join(sourceRoot, year);
    const yearStat = safeLstat(yearPath);
    if (!yearStat?.isDirectory() || yearStat.isSymbolicLink()) {
      return `unexpected Codex sessions year entry: ${yearPath}`;
    }
    for (const month of sortedEntries(yearPath)) {
      if (!/^\d{2}$/.test(month)) return `unexpected Codex sessions entry: ${join(yearPath, month)}`;
      const monthPath = join(yearPath, month);
      const monthStat = safeLstat(monthPath);
      if (!monthStat?.isDirectory() || monthStat.isSymbolicLink()) {
        return `unexpected Codex sessions month entry: ${monthPath}`;
      }
      for (const day of sortedEntries(monthPath)) {
        if (!/^\d{2}$/.test(day)) return `unexpected Codex sessions entry: ${join(monthPath, day)}`;
        const dayPath = join(monthPath, day);
        const dayStat = safeLstat(dayPath);
        if (!dayStat?.isDirectory() || dayStat.isSymbolicLink()) {
          return `unexpected Codex sessions day entry: ${dayPath}`;
        }
        for (const file of sortedEntries(dayPath)) {
          if (!/^rollout-[^/]+\.jsonl$/.test(file)) {
            return `unexpected Codex sessions entry: ${join(dayPath, file)}`;
          }
          const src = join(dayPath, file);
          const stat = safeLstat(src);
          if (stat === undefined) return `cannot scan Codex rollout file: ${src}`;
          if (stat.isSymbolicLink()) return `Codex rollout file is a symbolic link: ${src}`;
          if (!stat.isFile()) return `Codex rollout entry is not a regular file: ${src}`;
          if (stat.nlink !== 1) return `Codex rollout file is a hardlink: ${src}`;
          out.push({
            src,
            dest: join(hostHome, "sessions", year, month, day, file),
            year,
            month,
            day,
            existing: false,
          });
        }
      }
    }
  }
  return undefined;
}

function sortedEntries(dir: string): string[] {
  return readdirSync(dir).slice().sort();
}

function normalizePath(path: string): string {
  return resolve(path);
}

function pathContains(parent: string, child: string): boolean {
  const a = normalizePath(parent);
  const b = normalizePath(child);
  const rel = relative(a, b);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

function findProtectedOverlap(hostHome: string, protectedHostPaths: readonly string[]): string | undefined {
  const hostCandidates = [normalizePath(hostHome)];
  const hostReal = safeRealpath(hostHome);
  if (hostReal) hostCandidates.push(hostReal);
  for (const protectedPath of protectedHostPaths) {
    if (!protectedPath) continue;
    const protectedCandidates = [normalizePath(protectedPath)];
    const protectedReal = safeRealpath(protectedPath);
    if (protectedReal) protectedCandidates.push(protectedReal);
    for (const protectedCandidate of protectedCandidates) {
      for (const hostCandidate of hostCandidates) {
        if (
          pathContains(protectedCandidate, hostCandidate) ||
          pathContains(hostCandidate, protectedCandidate)
        ) {
          return protectedPath;
        }
      }
    }
  }
  return undefined;
}

function validateDestinationParents(dest: string, hostHome: string): string | undefined {
  const hostHomeWarning = validateExistingPathAncestors(hostHome);
  if (hostHomeWarning) return hostHomeWarning;
  const parentWarning = validateExistingPathAncestors(dirname(dest));
  if (parentWarning) return parentWarning;
  const destStat = safeLstat(dest);
  if (destStat?.isSymbolicLink()) return `Codex destination is a symbolic link: ${dest}`;
  return undefined;
}

function validateExistingPathAncestors(target: string): string | undefined {
  for (const part of pathAncestors(target)) {
    const stat = safeLstat(part);
    if (stat === undefined) continue;
    if (stat.isSymbolicLink()) return `Codex destination parent is a symbolic link: ${part}`;
    if (!stat.isDirectory()) return `Codex destination parent is not a directory: ${part}`;
  }
  return undefined;
}

function classifyExistingDestination(src: string, dest: string): CopyCodexSessionsResult {
  const destStat = safeLstat(dest);
  if (destStat === undefined) return ok(0, 0);
  if (!destStat.isFile()) return preserve(`Codex destination already exists and is not a regular file: ${dest}`);
  if (sha256(src) === sha256(dest)) return ok(0, 1);
  return preserve(`Codex destination already exists with different content: ${dest}`);
}

async function publishRollout(
  file: RolloutFile,
  beforePublish?: (destination: string) => void | Promise<void>,
): Promise<CopyCodexSessionsResult> {
  const existing = classifyExistingDestination(file.src, file.dest);
  if (file.existing) return ok(0, 0);
  if (existing.status === "preserve" || existing.existing > 0) return existing;

  const destDir = dirname(file.dest);
  const parentWarning = ensureDestinationDir(destDir, dirname(dirname(dirname(destDir))));
  if (parentWarning) return preserve(parentWarning);

  const temp = join(destDir, `.ccairgap-rollout.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, readFileSync(file.src));
    closeSync(fd);
    fd = undefined;
    await beforePublish?.(file.dest);
    copyFileSync(temp, file.dest, constants.COPYFILE_EXCL);
    return ok(1, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      const collision = classifyExistingDestination(file.src, file.dest);
      if (collision.existing > 0) return collision;
      return preserve(`Codex destination already exists with different content: ${file.dest}`);
    }
    return preserve(`Codex rollout publish failed for ${file.dest}: ${(e as Error).message}`);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best-effort cleanup
      }
    }
    try {
      unlinkSync(temp);
    } catch {
      // best-effort cleanup
    }
  }
}

function ensureDestinationDir(destDir: string, sessionsDir: string): string | undefined {
  const chain = pathChain(sessionsDir, destDir);
  for (const dir of chain) {
    const ancestorWarning = validateExistingPathAncestors(dir);
    if (ancestorWarning) return ancestorWarning;
    const stat = safeLstat(dir);
    if (stat !== undefined) {
      if (stat.isSymbolicLink()) return `Codex destination parent is a symbolic link: ${dir}`;
      if (!stat.isDirectory()) return `Codex destination parent is not a directory: ${dir}`;
      continue;
    }
    mkdirSync(dir, { mode: 0o700 });
    const created = safeLstat(dir);
    if (created?.isSymbolicLink()) return `Codex destination parent is a symbolic link: ${dir}`;
    if (!created?.isDirectory()) return `Codex destination parent is not a directory: ${dir}`;
  }
  return undefined;
}

function pathChain(from: string, to: string): string[] {
  const out: string[] = [];
  let current = normalizePath(from);
  const target = normalizePath(to);
  while (pathContains(current, target)) {
    out.push(current);
    if (current === target) break;
    const rel = relative(current, target);
    const nextPart = rel.split(sep)[0];
    if (!nextPart) break;
    current = join(current, nextPart);
  }
  return out;
}

function pathAncestors(target: string): string[] {
  const resolved = normalizePath(target);
  const root = parse(resolved).root;
  const rel = relative(root, resolved);
  if (!rel) return [root];
  const out = [root];
  let current = root;
  for (const part of rel.split(sep)) {
    current = join(current, part);
    out.push(current);
  }
  return out;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
