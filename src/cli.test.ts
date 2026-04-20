import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { splitClaudeArgs } from "./cliSplit.js";

describe("splitClaudeArgs", () => {
  let exitSpy: MockInstance;
  let errSpy: MockInstance;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("returns empty cliClaudeArgs when no `--` is present", () => {
    const r = splitClaudeArgs(["node", "ccairgap", "--repo", "."]);
    expect(r.cliClaudeArgs).toEqual([]);
    expect(r.argvForCommander).toEqual(["node", "ccairgap", "--repo", "."]);
  });

  it("splits on the first bare `--` and drops the separator", () => {
    const r = splitClaudeArgs([
      "node",
      "ccairgap",
      "--repo",
      ".",
      "--",
      "--model",
      "opus",
    ]);
    expect(r.argvForCommander).toEqual(["node", "ccairgap", "--repo", "."]);
    expect(r.cliClaudeArgs).toEqual(["--model", "opus"]);
  });

  it("keeps later `--` tokens inside the passthrough tail (only the first splits)", () => {
    const r = splitClaudeArgs(["node", "ccairgap", "--", "--model", "--", "x"]);
    expect(r.cliClaudeArgs).toEqual(["--model", "--", "x"]);
  });

  it("errors out (exit 1) when leading positional is a known subcommand", () => {
    expect(() =>
      splitClaudeArgs(["node", "ccairgap", "list", "--", "--model", "opus"]),
    ).toThrow(/process\.exit\(1\)/);
    expect(errSpy.mock.calls[0]?.[0]).toMatch(
      /-- passthrough is only valid on the default launch command, not on subcommand 'list'/,
    );
  });

  it("does NOT error when leading positional is an unknown command (commander preAction handles the typo)", () => {
    const r = splitClaudeArgs(["node", "ccairgap", "lsit", "--", "--model", "opus"]);
    expect(r.argvForCommander).toEqual(["node", "ccairgap", "lsit"]);
    expect(r.cliClaudeArgs).toEqual(["--model", "opus"]);
  });

  it("ignores options that precede the subcommand check (looks at first non-option)", () => {
    const r = splitClaudeArgs(["node", "ccairgap", "--config", "/tmp/x.yaml", "--", "--model", "opus"]);
    expect(r.argvForCommander).toEqual(["node", "ccairgap", "--config", "/tmp/x.yaml"]);
    expect(r.cliClaudeArgs).toEqual(["--model", "opus"]);
  });
});
