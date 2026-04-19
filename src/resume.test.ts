import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractLatestAgentName } from "./resume.js";

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
});
