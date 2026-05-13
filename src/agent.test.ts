import { describe, expect, it } from "vitest";
import {
  assertExhaustiveAgent,
  parseAgentKind,
  resolveAgentSelection,
  type AgentKind,
} from "./agent.js";

describe("agent selection", () => {
  it("defaults to Claude when config and CLI omit agent", () => {
    expect(resolveAgentSelection({})).toEqual({
      kind: "claude",
      mode: { agent: "claude", print: undefined, resume: undefined },
    });
  });

  it("selects Codex from config", () => {
    expect(resolveAgentSelection({ configAgent: "codex" })).toEqual({
      kind: "codex",
      mode: { agent: "codex", print: undefined },
    });
  });

  it("lets CLI agent override config agent", () => {
    expect(resolveAgentSelection({ configAgent: "codex", cliAgent: "claude" })).toEqual({
      kind: "claude",
      mode: { agent: "claude", print: undefined, resume: undefined },
    });
  });

  it("rejects unknown agent values with allowed values in the message", () => {
    expect(() => parseAgentKind("cursor", "--agent")).toThrow(
      /--agent: invalid agent 'cursor' \(allowed: claude, codex\)/,
    );
  });

  it("constructs Claude print and resume mode", () => {
    expect(
      resolveAgentSelection({
        cliAgent: "claude",
        print: "summarize",
        resume: "00000000-0000-0000-0000-000000000000",
      }).mode,
    ).toEqual({
      agent: "claude",
      print: "summarize",
      resume: "00000000-0000-0000-0000-000000000000",
    });
  });

  it("constructs Codex print mode without a resume field", () => {
    expect(
      resolveAgentSelection({
        cliAgent: "codex",
        print: "summarize",
        resume: "00000000-0000-0000-0000-000000000000",
      }).mode,
    ).toEqual({
      agent: "codex",
      print: "summarize",
    });
  });

  it("provides an exhaustive helper for agent switch statements", () => {
    function label(kind: AgentKind): string {
      switch (kind) {
        case "claude":
          return "Claude";
        case "codex":
          return "Codex";
        default:
          return assertExhaustiveAgent(kind);
      }
    }

    expect(label("claude")).toBe("Claude");
    expect(label("codex")).toBe("Codex");
    expect(() => assertExhaustiveAgent("future" as never)).toThrow(
      /Unhandled agent kind: future/,
    );
  });
});
