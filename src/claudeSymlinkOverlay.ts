import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { execa } from "execa";
import type { Mount } from "./mounts.js";

/**
 * Top-level entries inside `~/.claude/` that the overlay scan may enter.
 * These are the user-scope config paths listed at
 * https://code.claude.com/docs/en/claude-directory, plus `hooks` and
 * `statusline.sh`, which `settings.json` commonly references, and `plugins`.
 *
 * The scan uses an allowlist because application data can hold symlinks to
 * whole repositories (`jobs/<id>/tmp/src/<repo>`), and a denylist has to grow
 * with every new Claude Code data directory. Grow this list when Claude Code
 * ships a new user-scope config path.
 */
export const CLAUDE_OVERLAY_ALLOWLIST: ReadonlySet<string> = new Set([
  "CLAUDE.md",
  "settings.json",
  "keybindings.json",
  "statusline.sh",
  "agents",
  "agent-memory",
  "commands",
  "hooks",
  "output-styles",
  "plugins",
  "rules",
  "skills",
  "themes",
  "workflows",
]);

/** Path segments excluded anywhere in the tree. */
const ANYWHERE_EXCLUDED_SEGMENTS = new Set([".venv", "venv", ".git"]);

/**
 * rsync exit codes that leave a usable partial copy: 23 (partial transfer,
 * e.g. a dangling symlink or an unreadable file) and 24 (source files vanished
 * during the transfer). macOS openrsync reports a vanished file as 23, and GNU
 * rsync reports it as 24. The host uses whichever `rsync` is on PATH.
 */
const RSYNC_PARTIAL_EXIT_CODES = new Set([23, 24]);

function isExcludedRelPath(relPath: string): boolean {
  if (!CLAUDE_OVERLAY_ALLOWLIST.has(relPath.split("/")[0]!)) return true;
  if (relPath === "plugins/cache" || relPath.startsWith("plugins/cache/")) return true;
  for (const seg of relPath.split("/")) {
    if (ANYWHERE_EXCLUDED_SEGMENTS.has(seg)) return true;
  }
  return false;
}

export interface EscapingSymlinkEntry {
  /** Path relative to `~/.claude/` (e.g. `skills/ccairgap-configure`). */
  relPath: string;
  /** Raw `readlink` text — absolute, or relative with a target outside `~/.claude/`. */
  rawTarget: string;
}

/**
 * True iff `target` (raw `readlink` text of the link at `relPath`) points
 * outside `~/.claude/`. Absolute targets always count: the container sees
 * `~/.claude/` only at `/host-claude`. A relative target counts when its
 * lexical resolution from the link's directory leaves the root, e.g.
 * `skills/x → ../../.agents/skills/x`. Inside the container that path
 * resolves above `/host-claude` and does not exist.
 */
function targetEscapesRoot(relPath: string, target: string): boolean {
  if (isAbsolute(target)) return true;
  const root = "/r";
  const rel = relative(root, resolve(root, dirname(relPath), target));
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel);
}

/**
 * Walk the `CLAUDE_OVERLAY_ALLOWLIST` paths of the host `~/.claude/` tree and
 * return every symlink whose target is outside `~/.claude/` (see
 * `targetEscapesRoot`). Relative symlinks that stay inside `~/.claude/` are
 * skipped — they resolve correctly inside the container (rsync `-L` resolves
 * them from the link's location, and the tree under `/host-claude` matches the
 * host tree).
 *
 * The allowlist does not limit the size of a target. A symlink at
 * `skills/foo` that points at a large repository is still copied, minus the
 * names `materializeEscapingSymlinks` excludes.
 */
export function scanEscapingSymlinks(hostClaudeDir: string): EscapingSymlinkEntry[] {
  const out: EscapingSymlinkEntry[] = [];
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
        if (targetEscapesRoot(childRel, target)) {
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
 *
 * rsync exit codes in `RSYNC_PARTIAL_EXIT_CODES` produce a warning, and the
 * partial copy is still mounted. Every other failure throws.
 */
export async function materializeEscapingSymlinks(
  hostClaudeDir: string,
  symlinks: EscapingSymlinkEntry[],
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
      try {
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
      } catch (err) {
        const exitCode = (err as { exitCode?: number }).exitCode;
        if (exitCode === undefined || !RSYNC_PARTIAL_EXIT_CODES.has(exitCode)) throw err;
        console.error(
          `ccairgap: warning — some files in ${realTarget} could not be copied for ~/.claude/${e.relPath} (rsync exit ${exitCode}). Continuing with a partial copy.`,
        );
      }
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
 * list when the allowlisted paths have no symlinks that point outside `~/.claude/`.
 */
export async function buildClaudeSymlinkOverlay(
  hostClaudeDir: string,
  stageDir: string,
): Promise<Mount[]> {
  const symlinks = scanEscapingSymlinks(hostClaudeDir);
  if (symlinks.length === 0) return [];
  mkdirSync(stageDir, { recursive: true });
  const materialized = await materializeEscapingSymlinks(hostClaudeDir, symlinks, stageDir);
  return symlinkOverlayMounts(materialized);
}
