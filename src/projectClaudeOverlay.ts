import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

/**
 * Subpaths of `<hostPath>/.claude/` copied by the overlay. Closed allowlist —
 * matches Claude Code's documented project-scope layout. Anything else under
 * `.claude/` (user-parked worktrees, caches, logs) is skipped so the overlay
 * doesn't haul multi-GB trees into every session.
 *
 * Grow this list when Claude Code ships a new project-scope config path.
 */
export const PROJECT_CLAUDE_ALLOWLIST = [
  "settings.json",
  "settings.local.json",
  "commands",
  "agents",
  "skills",
  "hooks",
] as const;

/**
 * Overlay host working-tree Claude Code config into a freshly-cloned repo so
 * the container sees uncommitted / gitignored project-scope configuration.
 *
 * Paths copied when present:
 *   <hostPath>/.claude/{settings.json,settings.local.json,commands,agents,skills,hooks}
 *                          → <clonePath>/.claude/…   (rsync -rL, merge)
 *   <hostPath>/.mcp.json   → <clonePath>/.mcp.json   (rsync -L, overwrite)
 *   <hostPath>/CLAUDE.md   → <clonePath>/CLAUDE.md   (rsync -L, overwrite)
 *
 * `-L` follows symlinks so content flows through regardless of whether
 * `CLAUDE.md` is a real file or a symlink to `AGENTS.md`, and regardless of
 * whether a skill lives inside `.claude/skills/` or is a symlink to a shared
 * out-of-repo directory. The container only sees materialized files.
 *
 * Must run AFTER `gitCheckoutNewBranch` (working tree exists) and BEFORE
 * `applyHookPolicy` / `applyMcpPolicy` / `executeCopies` so policy filters
 * operate on the overlaid content and explicit `--cp` / `--sync` still wins.
 *
 * Paired with a pathspec exclusion in `dirtyTree` (`:(exclude).claude …`).
 * The exclude is a superset of this allowlist — broader exclude still
 * prevents false-positive preservation and covers container-side writes to
 * non-overlaid `.claude/*` paths (e.g. plugin install flows).
 */
export async function overlayProjectClaudeConfig(arg: {
  hostPath: string;
  clonePath: string;
  onWarning?: (msg: string) => void;
}): Promise<void> {
  const { hostPath, clonePath } = arg;
  const warn = arg.onWarning ?? ((m) => console.error(`ccairgap: ${m}`));

  const presentEntries = PROJECT_CLAUDE_ALLOWLIST.filter((e) =>
    existsSync(join(hostPath, ".claude", e)),
  );
  if (presentEntries.length > 0) {
    mkdirSync(join(clonePath, ".claude"), { recursive: true });
    for (const entry of presentEntries) {
      const src = join(hostPath, ".claude", entry);
      try {
        await execa("rsync", [
          "-rL",
          "--chmod=u+w",
          src,
          `${join(clonePath, ".claude")}/`,
        ]);
      } catch (e) {
        warn(
          `project .claude/${entry} overlay failed for ${hostPath}: ${(e as Error).message}`,
        );
      }
    }
  }

  for (const fname of [".mcp.json", "CLAUDE.md"]) {
    const src = join(hostPath, fname);
    if (!existsSync(src)) continue;
    try {
      await execa("rsync", ["-L", "--chmod=u+w", src, join(clonePath, fname)]);
    } catch (e) {
      warn(
        `project ${fname} overlay failed for ${hostPath}: ${(e as Error).message}`,
      );
    }
  }
}
