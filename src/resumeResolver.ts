import { open as fsOpen, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { encodeCwd } from "./paths.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Buffer size for head+tail reads — mirrors Claude Code's LITE_READ_BUF_SIZE. */
export const LITE_READ_BUF_SIZE = 65536;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Unescape a raw JSON string body (the bytes between the quotes). Only
 * allocates when escapes are present.
 */
function unescapeJsonString(raw: string): string {
  if (!raw.includes("\\")) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/**
 * Port of Claude Code's `extractLastJsonStringField`. Finds the LAST
 * `"key":"value"` or `"key": "value"` occurrence and returns the unescaped
 * value. Returns undefined if not present. No full JSON parse — tolerates
 * partial lines at chunk boundaries.
 */
export function extractLastJsonStringField(text: string, key: string): string | undefined {
  const patterns = [`"${key}":"`, `"${key}": "`];
  let lastValue: string | undefined;
  for (const pattern of patterns) {
    let searchFrom = 0;
    while (true) {
      const idx = text.indexOf(pattern, searchFrom);
      if (idx < 0) break;
      const valueStart = idx + pattern.length;
      let i = valueStart;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += 2;
          continue;
        }
        if (text[i] === '"') {
          lastValue = unescapeJsonString(text.slice(valueStart, i));
          break;
        }
        i++;
      }
      searchFrom = i + 1;
    }
  }
  return lastValue;
}

/**
 * Read first + last LITE_READ_BUF_SIZE bytes of a file. For small files where
 * head already covers the whole file, `tail === head`. Returns `{head:"",tail:""}`
 * on any I/O error.
 */
export async function readHeadAndTail(
  filePath: string,
  fileSize: number,
): Promise<{ head: string; tail: string }> {
  try {
    const fh = await fsOpen(filePath, "r");
    try {
      const buf = Buffer.allocUnsafe(LITE_READ_BUF_SIZE);
      const headRes = await fh.read(buf, 0, LITE_READ_BUF_SIZE, 0);
      if (headRes.bytesRead === 0) return { head: "", tail: "" };
      const head = buf.toString("utf8", 0, headRes.bytesRead);

      const tailOffset = Math.max(0, fileSize - LITE_READ_BUF_SIZE);
      let tail = head;
      if (tailOffset > 0) {
        const tailRes = await fh.read(buf, 0, LITE_READ_BUF_SIZE, tailOffset);
        tail = buf.toString("utf8", 0, tailRes.bytesRead);
      }
      return { head, tail };
    } finally {
      await fh.close();
    }
  } catch {
    return { head: "", tail: "" };
  }
}

/**
 * Current custom title of a transcript file. Reads tail first (appended
 * `custom-title` entries win — `/rename` and `-n` both append); falls back to
 * head for sessions too small for the tail window to differ.
 */
export async function readCustomTitle(filePath: string): Promise<string | undefined> {
  let size: number;
  try {
    size = (await stat(filePath)).size;
  } catch {
    return undefined;
  }
  if (size === 0) return undefined;
  const { head, tail } = await readHeadAndTail(filePath, size);
  return extractLastJsonStringField(tail, "customTitle")
    ?? extractLastJsonStringField(head, "customTitle");
}

export interface ResumeCandidate {
  uuid: string;
  customTitle?: string;
  mtimeMs: number;
}

/**
 * Enumerate `<projectDir>/*.jsonl` entries with their customTitle (if set)
 * and mtime. Used both by the resolver and by the exit-hint pretty-printer.
 * Silently skips unreadable/invalid entries.
 */
export async function listProjectSessions(projectDir: string): Promise<ResumeCandidate[]> {
  let entries: string[];
  try {
    entries = await readdir(projectDir);
  } catch {
    return [];
  }
  const out: ResumeCandidate[] = [];
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const uuid = name.slice(0, -6);
    if (!isUuid(uuid)) continue;
    const filePath = join(projectDir, name);
    let st;
    try {
      st = await stat(filePath);
    } catch {
      continue;
    }
    if (!st.isFile() || st.size === 0) continue;
    const customTitle = await readCustomTitle(filePath);
    out.push({ uuid, customTitle, mtimeMs: st.mtimeMs });
  }
  return out;
}

export interface ResolveResumeArgArgs {
  /** Resolved host `~/.claude/` dir (realpath'd by caller). */
  hostClaudeDir: string;
  /** Realpath of the workspace repo — used for `encodeCwd`. */
  workspaceHostPath: string;
  /** Raw `--resume` value: either a session UUID or a custom title. */
  arg: string;
}

export interface ResolvedResumeArg {
  uuid: string;
  /** `undefined` when the arg was a UUID — we didn't need to read transcripts. */
  customTitle?: string;
}

/**
 * Resolve a `--resume` argument to a Claude session UUID.
 *
 * UUID → passthrough (no transcript reads; `resolveResumeSource` validates
 * existence later).
 *
 * Otherwise: enumerate the workspace's transcripts dir, match customTitle
 * case-insensitively (same as Claude Code's `searchSessionsByCustomTitle`
 * with `exact: true`). 1 match → return its UUID. 0 or >1 → throw with
 * actionable candidate list.
 */
export async function resolveResumeArg(args: ResolveResumeArgArgs): Promise<ResolvedResumeArg> {
  const { hostClaudeDir, workspaceHostPath, arg } = args;
  if (isUuid(arg)) return { uuid: arg };

  const projectDir = join(hostClaudeDir, "projects", encodeCwd(workspaceHostPath));
  const candidates = await listProjectSessions(projectDir);
  const query = arg.toLowerCase().trim();
  const matches = candidates.filter(
    (c) => (c.customTitle ?? "").toLowerCase().trim() === query,
  );

  if (matches.length === 1) {
    const m = matches[0]!;
    return { uuid: m.uuid, customTitle: m.customTitle };
  }

  if (matches.length === 0) {
    const titled = candidates
      .filter((c) => c.customTitle)
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    if (titled.length === 0) {
      throw new Error(
        `--resume ${arg}: no session with that name found under ${projectDir}. ` +
          `No sessions have a custom title (use the UUID instead, or rename one first).`,
      );
    }
    const list = titled
      .slice(0, 10)
      .map((c) => `  ${c.uuid}  ${c.customTitle}`)
      .join("\n");
    throw new Error(
      `--resume ${arg}: no session with that exact name. Recent titled sessions:\n${list}`,
    );
  }

  // matches.length > 1: multiple sessions share the exact title (same name
  // across time). Show UUIDs so the user can disambiguate.
  const list = matches
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((c) => `  ${c.uuid}  (${new Date(c.mtimeMs).toISOString()})`)
    .join("\n");
  throw new Error(
    `--resume ${arg}: ${matches.length} sessions share this name. Pick a UUID:\n${list}`,
  );
}
