import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { execaSync } from "execa";
import { encodeCwd } from "./paths.js";

export interface ResolveResumeSourceArgs {
  /** Resolved path of the host's `~/.claude/` dir. Source root is `<hostClaudeDir>/projects/<encoded>/`. */
  hostClaudeDir: string;
  /** Realpath of the workspace repo (`repoEntries[0].hostPath`). Used for `encodeCwd` to locate the source dir. */
  workspaceHostPath: string;
  /** The `--resume` UUID. Not validated locally — passthrough to claude. */
  uuid: string;
}

export interface ResolvedResumeSource {
  /** `encodeCwd(workspaceHostPath)` — used again when placing files under `$SESSION/transcripts/<encoded>/`. */
  encoded: string;
  /** Absolute host path of the required `<uuid>.jsonl` file. Guaranteed to exist. */
  srcJsonl: string;
  /** Absolute host path of the optional `<uuid>/` sibling dir (contains `subagents/…`). `undefined` when absent. */
  srcSubagentsDir?: string;
}

export interface CopyResumeTranscriptArgs {
  /** `$SESSION` — must already contain `transcripts/` (caller mkdir'd it). */
  sessionDir: string;
  /** Resolved source bundle from `resolveResumeSource`. */
  source: ResolvedResumeSource;
}

/**
 * Validate the host-born transcript is reachable. Pure reads — safe to run in
 * the validation phase of `launch()` before any session-dir is created.
 * Throws with the spec-mandated error when the main `.jsonl` is missing; the
 * `<uuid>/` sibling dir is optional.
 */
export function resolveResumeSource(args: ResolveResumeSourceArgs): ResolvedResumeSource {
  const { hostClaudeDir, workspaceHostPath, uuid } = args;
  const encoded = encodeCwd(workspaceHostPath);
  const srcDir = join(hostClaudeDir, "projects", encoded);
  const srcJsonl = join(srcDir, `${uuid}.jsonl`);
  const srcSubagentsRoot = join(srcDir, uuid);

  if (!existsSync(srcJsonl)) {
    throw new Error(`--resume ${uuid}: transcript not found at ${srcJsonl}`);
  }

  const srcSubagentsDir =
    existsSync(srcSubagentsRoot) && statSync(srcSubagentsRoot).isDirectory()
      ? srcSubagentsRoot
      : undefined;

  return {
    encoded,
    srcJsonl,
    ...(srcSubagentsDir !== undefined ? { srcSubagentsDir } : {}),
  };
}

/**
 * Copy the resolved resume source files into `$SESSION/transcripts/<encoded>/`.
 * Caller must have mkdir'd `$SESSION/transcripts/` already. Uses `cp -a` so
 * the container can append to the jsonl without corrupting the host copy
 * (hardlinks would break this property).
 */
export function copyResumeTranscript(args: CopyResumeTranscriptArgs): void {
  const { sessionDir, source } = args;
  const { encoded, srcJsonl, srcSubagentsDir } = source;

  const dstDir = join(sessionDir, "transcripts", encoded);
  mkdirSync(dstDir, { recursive: true });

  const uuidBase = basename(srcJsonl); // `<uuid>.jsonl`
  execaSync("cp", ["-a", srcJsonl, join(dstDir, uuidBase)]);

  if (srcSubagentsDir !== undefined) {
    const subBasename = basename(srcSubagentsDir); // `<uuid>`
    execaSync("cp", ["-a", srcSubagentsDir, join(dstDir, subBasename)]);
  }
}
