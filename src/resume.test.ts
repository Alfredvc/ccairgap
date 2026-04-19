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
import {
  extractLatestAgentName,
  resolveResumeSource,
  copyResumeTranscript,
  REVERSE_READ_CHUNK,
} from "./resume.js";

describe("extractLatestAgentName", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "resume-name-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when file is missing", () => {
    expect(extractLatestAgentName(join(dir, "nope.jsonl"))).toBeUndefined();
  });

  it("returns undefined when jsonl has no agent-name entry", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      ['{"type":"user","message":{"content":"hi"}}', '{"type":"assistant","message":{"content":"yo"}}'].join("\n"),
    );
    expect(extractLatestAgentName(p)).toBeUndefined();
  });

  it("returns agentName from the only entry present", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      ['{"type":"user","message":{"content":"hi"}}', '{"type":"agent-name","agentName":"only-one"}'].join("\n"),
    );
    expect(extractLatestAgentName(p)).toBe("only-one");
  });

  it("returns the most recent entry when multiple agent-name entries exist", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      [
        '{"type":"agent-name","agentName":"first"}',
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"agent-name","agentName":"middle"}',
        '{"type":"assistant","message":{"content":"ok"}}',
        '{"type":"agent-name","agentName":"latest"}',
        '{"type":"user","message":{"content":"bye"}}',
      ].join("\n"),
    );
    expect(extractLatestAgentName(p)).toBe("latest");
  });

  it("skips malformed lines and keeps searching", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(
      p,
      [
        '{"type":"agent-name","agentName":"target"}',
        "this is not json at all",
        '{"type":"user","message":{"content":"after garbage"}}',
      ].join("\n"),
    );
    expect(extractLatestAgentName(p)).toBe("target");
  });

  it("ignores blank trailing lines", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, '{"type":"agent-name","agentName":"trailing"}\n\n\n');
    expect(extractLatestAgentName(p)).toBe("trailing");
  });

  it("returns undefined when agent-name entry lacks agentName field", () => {
    const p = join(dir, "t.jsonl");
    writeFileSync(p, '{"type":"agent-name"}\n');
    expect(extractLatestAgentName(p)).toBeUndefined();
  });

  it("returns the latest agent-name from a transcript larger than the reverse-read chunk", () => {
    const p = join(dir, "big.jsonl");
    // Build ~200 KB of padding lines, then the target agent-name as the last line.
    const padLine = '{"type":"user","message":{"content":"' + "x".repeat(200) + '"}}';
    const padCount = Math.ceil((200 * 1024) / (padLine.length + 1));
    const lines: string[] = [];
    for (let i = 0; i < padCount; i++) lines.push(padLine);
    lines.push('{"type":"agent-name","agentName":"target"}');
    writeFileSync(p, lines.join("\n") + "\n");
    // Sanity: file is genuinely larger than the chunk so the reverse-read loop
    // exercises more than one iteration.
    expect(statSync(p).size).toBeGreaterThan(REVERSE_READ_CHUNK);
    expect(extractLatestAgentName(p)).toBe("target");
  });

  it("handles an agent-name line that straddles a chunk boundary", () => {
    const p = join(dir, "straddle.jsonl");
    const targetLine = '{"type":"agent-name","agentName":"split-target"}';
    // File layout: <padBefore><target>\n<padAfter>. Boundary between chunk 1
    // (rightmost) and chunk 2 sits at byte `size - REVERSE_READ_CHUNK`.
    // Place the target so it straddles that boundary: target starts well left
    // of the boundary, ends well right of it. Total file size = 2 * CHUNK
    // (so chunk 2 is full, exercising the boundary logic).
    const totalSize = REVERSE_READ_CHUNK * 2;
    const targetByteLen = targetLine.length + 1; // +1 for trailing \n
    // padBefore positions target start so that target straddles the boundary.
    // Boundary is at `totalSize - REVERSE_READ_CHUNK`. We want target's middle
    // ~at the boundary, so target start ≈ boundary - targetLine.length/2.
    const padBeforeBytes =
      totalSize - REVERSE_READ_CHUNK - Math.floor(targetLine.length / 2);
    // Both pads must end in \n so each line is JSONL-parseable. Build padBefore
    // from a short repeating line + a custom-length final line, sized exactly.
    const buildPad = (n: number): string => {
      const unit = '{"type":"user","message":{"content":"x"}}\n';
      const repeats = Math.floor(n / unit.length);
      let out = unit.repeat(repeats);
      const remainder = n - out.length;
      if (remainder === 0) return out;
      // Construct a single \n-terminated JSON line of `remainder` bytes.
      const wrapper = '{"type":"user","message":{"content":""}}';
      const inner = remainder - 1 - wrapper.length;
      if (inner < 0) {
        // Too small for a JSON line — pad with empty lines (just \n bytes).
        return out + "\n".repeat(remainder);
      }
      out += `{"type":"user","message":{"content":"${"x".repeat(inner)}"}}\n`;
      return out;
    };
    const padBefore = buildPad(padBeforeBytes);
    const padAfterBytes = totalSize - padBefore.length - targetByteLen;
    const padAfter = buildPad(padAfterBytes);
    const content = padBefore + targetLine + "\n" + padAfter;
    writeFileSync(p, content);
    // Sanity: file size matches and target straddles the boundary.
    const stat = statSync(p);
    expect(stat.size).toBe(totalSize);
    const boundary = stat.size - REVERSE_READ_CHUNK;
    const targetStart = padBefore.length;
    const targetEnd = targetStart + targetLine.length; // last byte of JSON, before \n
    expect(targetStart).toBeLessThan(boundary);
    expect(targetEnd).toBeGreaterThan(boundary);
    expect(extractLatestAgentName(p)).toBe("split-target");
  });
});

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

  it("returns resolved paths + undefined origName when only the flat jsonl exists", () => {
    const src = writeSourceJsonl(['{"type":"user","message":{"content":"hi"}}']);
    const result = resolveResumeSource({ hostClaudeDir: hostClaude, workspaceHostPath: workspace, uuid });
    expect(result).toEqual({
      encoded,
      srcJsonl: src,
      srcSubagentsDir: undefined,
      origName: undefined,
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

  it("returns the latest agent-name when present", () => {
    writeSourceJsonl([
      '{"type":"agent-name","agentName":"old"}',
      '{"type":"user","message":{"content":"hi"}}',
      '{"type":"agent-name","agentName":"latest"}',
    ]);
    const result = resolveResumeSource({ hostClaudeDir: hostClaude, workspaceHostPath: workspace, uuid });
    expect(result.origName).toBe("latest");
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
  const workspace = "/Users/alice/src/proj";
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
      source: { encoded, srcJsonl: src, srcSubagentsDir: undefined, origName: undefined },
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
      source: { encoded, srcJsonl: src, srcSubagentsDir: subRoot, origName: undefined },
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
      source: { encoded, srcJsonl: src, srcSubagentsDir: undefined, origName: undefined },
    });
    const dstStat = statSync(join(session, "transcripts", encoded, `${uuid}.jsonl`));
    expect(dstStat.mode & 0o777).toBe(srcStat.mode & 0o777);
  });
});
