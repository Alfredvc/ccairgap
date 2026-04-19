import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { execaSync } from "execa";
import { encodeCwd } from "./paths.js";

/**
 * Read a Claude Code transcript jsonl and return the latest `agentName` from an
 * `agent-name`-typed entry, or `undefined` if the file is missing, has no such
 * entry, or every candidate line fails to parse. Reverse-scans so rename-heavy
 * sessions short-circuit without reading the whole file.
 *
 * Fail-open: any JSON.parse error on a line is swallowed; scan continues.
 */
export function extractLatestAgentName(jsonlPath: string): string | undefined {
  if (!existsSync(jsonlPath)) return undefined;
  const text = readFileSync(jsonlPath, "utf8");
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      obj !== null &&
      typeof obj === "object" &&
      (obj as { type?: unknown }).type === "agent-name" &&
      typeof (obj as { agentName?: unknown }).agentName === "string"
    ) {
      return (obj as { agentName: string }).agentName;
    }
  }
  return undefined;
}

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
  /** Latest `agentName` from the jsonl, if any. Absent when no `agent-name` entry exists. */
  origName?: string;
}

export interface CopyResumeTranscriptArgs {
  /** `$SESSION` — must already contain `transcripts/` (caller mkdir'd it). */
  sessionDir: string;
  /** Resolved source bundle from `resolveResumeSource`. */
  source: ResolvedResumeSource;
}

/**
 * Validate the host-born transcript is reachable and extract the display
 * name. Pure reads — safe to run in the validation phase of `launch()`
 * before any session-dir is created. Throws with the spec-mandated error
 * when the main `.jsonl` is missing; the `<uuid>/` sibling dir is optional.
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

  const origName = extractLatestAgentName(srcJsonl);

  return {
    encoded,
    srcJsonl,
    ...(srcSubagentsDir !== undefined ? { srcSubagentsDir } : {}),
    ...(origName !== undefined ? { origName } : {}),
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

  const uuidBase = srcJsonl.slice(srcJsonl.lastIndexOf("/") + 1); // `<uuid>.jsonl`
  execaSync("cp", ["-a", srcJsonl, join(dstDir, uuidBase)]);

  if (srcSubagentsDir !== undefined) {
    const subBasename = srcSubagentsDir.slice(srcSubagentsDir.lastIndexOf("/") + 1); // `<uuid>`
    execaSync("cp", ["-a", srcSubagentsDir, join(dstDir, subBasename)]);
  }
}
