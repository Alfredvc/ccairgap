import { existsSync } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";

/**
 * Overlay host working-tree Claude Code config into a freshly-cloned repo so
 * the container sees uncommitted / gitignored project-scope configuration.
 *
 * Three host paths copied when present:
 *   <hostPath>/.claude/    → <clonePath>/.claude/    (rsync -rL, merge)
 *   <hostPath>/.mcp.json   → <clonePath>/.mcp.json   (rsync -L, overwrite)
 *   <hostPath>/CLAUDE.md   → <clonePath>/CLAUDE.md   (rsync -L, overwrite)
 *
 * `-L` follows symlinks so content flows through regardless of whether
 * `CLAUDE.md` is a real file or a symlink to `AGENTS.md`, and regardless of
 * whether a skill lives inside `.claude/` or is a symlink to a shared
 * out-of-repo directory. The container only sees materialized files.
 *
 * Must run AFTER `gitCheckoutNewBranch` (working tree exists) and BEFORE
 * `applyHookPolicy` / `applyMcpPolicy` / `executeCopies` so policy filters
 * operate on the overlaid content and explicit `--cp` / `--sync` still wins.
 *
 * Paired with a pathspec exclusion in `dirtyTree` — overlay-introduced
 * "uncommitted" state in these three paths must not trigger the exit-time
 * preservation flow. Consequence: container-side edits to these paths are
 * also lost on exit. By design (sandbox shouldn't mutate Claude config).
 */
export async function overlayProjectClaudeConfig(arg: {
  hostPath: string;
  clonePath: string;
  onWarning?: (msg: string) => void;
}): Promise<void> {
  const { hostPath, clonePath } = arg;
  const warn = arg.onWarning ?? ((m) => console.error(`ccairgap: ${m}`));

  const dirSrc = join(hostPath, ".claude");
  if (existsSync(dirSrc)) {
    try {
      await execa("rsync", [
        "-rL",
        "--chmod=u+w",
        `${dirSrc}/`,
        `${join(clonePath, ".claude")}/`,
      ]);
    } catch (e) {
      warn(
        `project .claude overlay failed for ${hostPath}: ${(e as Error).message}`,
      );
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
