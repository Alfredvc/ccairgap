import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveResumeSource, copyResumeTranscript } from "./resume.js";

describe("resolveResumeSource", () => {
  let root: string;
  let hostClaude: string;
  const workspace = "/Users/alice/src/proj";
  const encoded = "-Users-alice-src-proj";
  const uuid = "01234567-89ab-cdef-0123-456789abcdef";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "resume-resolve-"));
    hostClaude = join(root, ".claude");
    mkdirSync(join(hostClaude, "projects", encoded), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSourceJsonl(lines: string[]): string {
    const p = join(hostClaude, "projects", encoded, `${uuid}.jsonl`);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  it("returns resolved paths with no subagents dir when only the flat jsonl exists", () => {
    const src = writeSourceJsonl(['{"type":"user","message":{"content":"hi"}}']);
    const result = resolveResumeSource({ hostClaudeDir: hostClaude, workspaceHostPath: workspace, uuid });
    expect(result).toEqual({
      encoded,
      srcJsonl: src,
    });
  });

  it("returns srcSubagentsDir when the sibling <uuid>/ dir exists", () => {
    writeSourceJsonl(['{"type":"user"}']);
    const subRoot = join(hostClaude, "projects", encoded, uuid);
    mkdirSync(join(subRoot, "subagents"), { recursive: true });
    const result = resolveResumeSource({ hostClaudeDir: hostClaude, workspaceHostPath: workspace, uuid });
    expect(result.srcSubagentsDir).toBe(subRoot);
  });

  it("throws the exact spec error when the jsonl is missing", () => {
    const missing = join(hostClaude, "projects", encoded, `${uuid}.jsonl`);
    expect(() =>
      resolveResumeSource({ hostClaudeDir: hostClaude, workspaceHostPath: workspace, uuid }),
    ).toThrow(`--resume ${uuid}: transcript not found at ${missing}`);
  });

  it("does not create any directories (pure reads)", () => {
    writeSourceJsonl(['{"type":"user"}']);
    const beforeCount = readdirRecursiveCount(root);
    resolveResumeSource({ hostClaudeDir: hostClaude, workspaceHostPath: workspace, uuid });
    expect(readdirRecursiveCount(root)).toBe(beforeCount);
  });
});

function readdirRecursiveCount(dir: string): number {
  let count = 0;
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      count++;
      if (statSync(p).isDirectory()) walk(p);
    }
  };
  walk(dir);
  return count;
}

describe("copyResumeTranscript", () => {
  let root: string;
  let hostClaude: string;
  let session: string;
  const encoded = "-Users-alice-src-proj";
  const uuid = "01234567-89ab-cdef-0123-456789abcdef";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "resume-copy-"));
    hostClaude = join(root, ".claude");
    mkdirSync(join(hostClaude, "projects", encoded), { recursive: true });
    session = join(root, "session");
    mkdirSync(join(session, "transcripts"), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSourceJsonl(lines: string[]): string {
    const p = join(hostClaude, "projects", encoded, `${uuid}.jsonl`);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  it("copies the flat jsonl when no subagents dir is provided", () => {
    const src = writeSourceJsonl(['{"type":"user","message":{"content":"hi"}}']);
    copyResumeTranscript({
      sessionDir: session,
      source: { encoded, srcJsonl: src },
    });
    const dst = join(session, "transcripts", encoded, `${uuid}.jsonl`);
    expect(existsSync(dst)).toBe(true);
    expect(readFileSync(dst, "utf8")).toContain('"type":"user"');
  });

  it("copies both the flat jsonl and the <uuid>/ sibling dir including subagents files", () => {
    const src = writeSourceJsonl(['{"type":"user"}']);
    const subRoot = join(hostClaude, "projects", encoded, uuid);
    const subDir = join(subRoot, "subagents");
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, "agent-1.jsonl"), '{"type":"user"}\n');
    writeFileSync(join(subDir, "agent-1.meta.json"), '{"agentId":"agent-1"}\n');

    copyResumeTranscript({
      sessionDir: session,
      source: { encoded, srcJsonl: src, srcSubagentsDir: subRoot },
    });

    const dstBase = join(session, "transcripts", encoded);
    expect(existsSync(join(dstBase, `${uuid}.jsonl`))).toBe(true);
    expect(existsSync(join(dstBase, uuid, "subagents", "agent-1.jsonl"))).toBe(true);
    expect(existsSync(join(dstBase, uuid, "subagents", "agent-1.meta.json"))).toBe(true);
  });

  it("preserves permissions via cp -a", () => {
    const src = writeSourceJsonl(['{"type":"user"}']);
    const srcStat = statSync(src);
    copyResumeTranscript({
      sessionDir: session,
      source: { encoded, srcJsonl: src },
    });
    const dstStat = statSync(join(session, "transcripts", encoded, `${uuid}.jsonl`));
    expect(dstStat.mode & 0o777).toBe(srcStat.mode & 0o777);
  });
});
