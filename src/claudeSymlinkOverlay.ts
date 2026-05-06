import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { execa } from "execa";
import type { Mount } from "./mounts.js";

/**
 * Top-level entries inside `~/.claude/` that the entrypoint rsync excludes.
 * Walking into them produces noise and copies state we'd discard anyway.
 * Mirrors the exclude list in `docker/entrypoint.sh`.
 */
const TOP_LEVEL_EXCLUDES = new Set([
  "projects",
  "sessions",
  "history.jsonl",
  "todos",
  "shell-snapshots",
  "debug",
  "paste-cache",
  "session-env",
  "file-history",
]);

/** Path segments excluded anywhere in the tree. */
const ANYWHERE_EXCLUDED_SEGMENTS = new Set([".venv", "venv", ".git"]);

function isExcludedRelPath(relPath: string): boolean {
  if (TOP_LEVEL_EXCLUDES.has(relPath)) return true;
  if (relPath === "plugins/cache" || relPath.startsWith("plugins/cache/")) return true;
  for (const seg of relPath.split("/")) {
    if (ANYWHERE_EXCLUDED_SEGMENTS.has(seg)) return true;
  }
  return false;
}

export interface AbsoluteSymlinkEntry {
  /** Path relative to `~/.claude/` (e.g. `skills/ccairgap-configure`). */
  relPath: string;
  /** Raw `readlink` text — always absolute. */
  rawTarget: string;
}

/**
 * Walk the host `~/.claude/` tree and return every symlink whose `readlink`
 * text is an absolute path. Relative symlinks are skipped — they resolve
 * correctly inside the container (rsync `-L` handles them path-relative to
 * the link's location, which matches between host and container).
 *
 * Excluded subtrees match the entrypoint rsync excludes plus `.git/`. This
 * keeps the overlay minimal and avoids materializing huge dirs (build output,
 * full repos symlinked under `~/.claude/agents/`, etc.).
 */
export function scanAbsoluteSymlinks(hostClaudeDir: string): AbsoluteSymlinkEntry[] {
  const out: AbsoluteSymlinkEntry[] = [];
  if (!existsSync(hostClaudeDir)) return out;

  const walk = (relPath: string): void => {
    const fullPath = relPath === "" ? hostClaudeDir : join(hostClaudeDir, relPath);
    let entries;
    try {
      entries = readdirSync(fullPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      const childRel = relPath === "" ? d.name : `${relPath}/${d.name}`;
      if (isExcludedRelPath(childRel)) continue;
      if (d.isSymbolicLink()) {
        let target: string;
        try {
          target = readlinkSync(join(fullPath, d.name));
        } catch {
          continue;
        }
        if (isAbsolute(target)) {
          out.push({ relPath: childRel, rawTarget: target });
        }
      } else if (d.isDirectory()) {
        walk(childRel);
      }
    }
  };
  walk("");
  return out;
}

export interface MaterializedSymlink {
  /** Path relative to `~/.claude/`. */
  relPath: string;
  /** Absolute path inside the session staging dir where the target was copied. */
  stagePath: string;
  isDir: boolean;
}

/**
 * Resolve each symlink target host-side, copy its contents into
 * `$SESSION/claude-symlink-overlay/<relPath>`, and return entries describing
 * what landed on disk. Skips entries whose target is missing on the host
 * (already broken — warn and continue).
 *
 * Directory targets go through `rsync -rL` with the same exclude set the
 * entrypoint uses, plus `.git`, so we don't drag node_modules / venv / git
 * history into the overlay. File targets use `cp -L`.
 */
export async function materializeAbsoluteSymlinks(
  hostClaudeDir: string,
  symlinks: AbsoluteSymlinkEntry[],
  stageDir: string,
): Promise<MaterializedSymlink[]> {
  const out: MaterializedSymlink[] = [];
  for (const e of symlinks) {
    const linkPath = join(hostClaudeDir, e.relPath);
    let realTarget: string;
    try {
      realTarget = realpathSync(linkPath);
    } catch {
      console.error(
        `ccairgap: warning — symlink ~/.claude/${e.relPath} → ${e.rawTarget} target missing on host. Skipping.`,
      );
      continue;
    }
    let targetStat;
    try {
      targetStat = lstatSync(realTarget);
    } catch {
      console.error(
        `ccairgap: warning — symlink ~/.claude/${e.relPath} target ${realTarget} unreadable. Skipping.`,
      );
      continue;
    }
    const stagePath = join(stageDir, e.relPath);
    mkdirSync(dirname(stagePath), { recursive: true });

    if (targetStat.isDirectory()) {
      mkdirSync(stagePath, { recursive: true });
      await execa("rsync", [
        "-rL",
        "--chmod=u+w",
        "--exclude=.DS_Store",
        "--exclude=.git",
        "--exclude=.venv",
        "--exclude=venv",
        "--exclude=node_modules",
        `${realTarget}/`,
        `${stagePath}/`,
      ]);
      out.push({ relPath: e.relPath, stagePath, isDir: true });
    } else {
      await execa("cp", ["-L", realTarget, stagePath]);
      out.push({ relPath: e.relPath, stagePath, isDir: false });
    }
  }
  return out;
}

/**
 * Convert materialized entries into RO bind mounts at
 * `/host-claude/<relPath>`. Source kind is `claude-symlink-overlay` so the
 * collision resolver's user-source guard does not fire on `/host-claude`-
 * prefixed paths (these are ccairgap-internal mounts).
 */
export function symlinkOverlayMounts(materialized: MaterializedSymlink[]): Mount[] {
  return materialized.map((m) => ({
    src: m.stagePath,
    dst: `/host-claude/${m.relPath}`,
    mode: "ro" as const,
    source: { kind: "claude-symlink-overlay" as const, relPath: m.relPath },
  }));
}

/**
 * Convenience wrapper: scan, materialize, return mounts. Returns an empty
 * list when `~/.claude/` has no absolute symlinks (the common case).
 */
export async function buildClaudeSymlinkOverlay(
  hostClaudeDir: string,
  stageDir: string,
): Promise<Mount[]> {
  const symlinks = scanAbsoluteSymlinks(hostClaudeDir);
  if (symlinks.length === 0) return [];
  mkdirSync(stageDir, { recursive: true });
  const materialized = await materializeAbsoluteSymlinks(hostClaudeDir, symlinks, stageDir);
  return symlinkOverlayMounts(materialized);
}
