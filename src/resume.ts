import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { execaSync } from "execa";
import { encodeCwd } from "./paths.js";

/** Reverse-read chunk size. Exported for tests that need to straddle a chunk boundary. */
export const REVERSE_READ_CHUNK = 64 * 1024;

/**
 * Returns the `agentName` of an `agent-name`-typed JSONL entry, parsed as JSON
 * one line at a time. Returns `undefined` if the line is empty, fails to parse,
 * or doesn't carry the expected shape. Fail-open by design — bad lines never
 * abort the surrounding scan.
 */
function tryExtractAgentNameFromLine(line: string): string | undefined {
  if (line.length === 0) return undefined;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    obj !== null &&
    typeof obj === "object" &&
    (obj as { type?: unknown }).type === "agent-name" &&
    typeof (obj as { agentName?: unknown }).agentName === "string"
  ) {
    return (obj as { agentName: string }).agentName;
  }
  return undefined;
}

/**
 * Read a Claude Code transcript jsonl and return the latest `agentName` from an
 * `agent-name`-typed entry, or `undefined` if the file is missing, has no such
 * entry, or every candidate line fails to parse.
 *
 * Reverse-reads the file in 64 KiB chunks from the end so rename-heavy sessions
 * return without scanning the whole transcript. Newline (0x0A) byte scanning is
 * UTF-8 safe because no continuation byte equals 0x0A.
 *
 * Fail-open: any JSON.parse error on a line is swallowed; scan continues.
 */
export function extractLatestAgentName(jsonlPath: string): string | undefined {
  if (!existsSync(jsonlPath)) return undefined;

  const fd = openSync(jsonlPath, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return undefined;

    let pos = size;
    let tail = Buffer.alloc(0);

    while (pos > 0) {
      const readLen = Math.min(REVERSE_READ_CHUNK, pos);
      const buf = Buffer.alloc(readLen + tail.length);
      readSync(fd, buf, 0, readLen, pos - readLen);
      tail.copy(buf, readLen);
      pos -= readLen;

      // Walk byte-by-byte from the right looking for `\n` (0x0A). Each newline
      // marks the end of a complete line whose bytes are (i+1)..lineEnd.
      let lineEnd = buf.length;
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i] !== 0x0a) continue;
        const line = buf.toString("utf8", i + 1, lineEnd);
        const found = tryExtractAgentNameFromLine(line);
        if (found !== undefined) return found;
        lineEnd = i;
      }

      // Bytes 0..lineEnd are an incomplete line at the left edge of this chunk
      // — preserve them as the tail so the next iteration sees them on the right.
      tail = buf.subarray(0, lineEnd);
    }

    // Last `tail` after pos hits 0 is the very first line of the file.
    if (tail.length > 0) {
      const found = tryExtractAgentNameFromLine(tail.toString("utf8"));
      if (found !== undefined) return found;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
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

  const uuidBase = basename(srcJsonl); // `<uuid>.jsonl`
  execaSync("cp", ["-a", srcJsonl, join(dstDir, uuidBase)]);

  if (srcSubagentsDir !== undefined) {
    const subBasename = basename(srcSubagentsDir); // `<uuid>`
    execaSync("cp", ["-a", srcSubagentsDir, join(dstDir, subBasename)]);
  }
}
