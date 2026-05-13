import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { splitClaudeArgs, splitSelectedAgentArgs } from "./cliSplit.js";

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

  it("preserves launch passthrough after `--` as a raw ordered tail", () => {
    const r = splitClaudeArgs([
      "node",
      "ccairgap",
      "--repo",
      ".",
      "--",
      "--permission-mode",
      "plan",
      "--dangerously-skip-permissions",
    ]);
    expect(r.argvForCommander).toEqual(["node", "ccairgap", "--repo", "."]);
    expect(r.cliClaudeArgs).toEqual([
      "--permission-mode",
      "plan",
      "--dangerously-skip-permissions",
    ]);
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

  it("blocks -- passthrough on install-completion / uninstall-completion subcommands", () => {
    for (const sub of ["install-completion", "uninstall-completion"]) {
      expect(() => splitClaudeArgs(["node", "ccairgap", sub, "--", "x"])).toThrow(/process\.exit\(1\)/);
    }
  });

  it("allows -- passthrough on attach as the selected-agent tail", () => {
    const r = splitSelectedAgentArgs([
      "node",
      "ccairgap",
      "attach",
      "--agent",
      "codex",
      "live-abcd",
      "--",
      "--model",
      "gpt-5",
    ]);
    expect(r.argvForCommander).toEqual([
      "node",
      "ccairgap",
      "attach",
      "--agent",
      "codex",
      "live-abcd",
    ]);
    expect(r.cliSelectedAgentArgs).toEqual(["--model", "gpt-5"]);
  });

  it("silently drops the `--` tail on `completion-server` (tabtab callback)", () => {
    // tabtab's generated completer shells out `ccairgap completion-server -- <words>`.
    // Erroring on the `--` would kill tab-completion. The callback reads COMP_* env,
    // not argv, so the tail is discarded.
    const r = splitClaudeArgs([
      "node",
      "ccairgap",
      "completion-server",
      "--",
      "ccairgap",
      "--res",
    ]);
    expect(r.argvForCommander).toEqual(["node", "ccairgap", "completion-server"]);
    expect(r.cliClaudeArgs).toEqual([]);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it("ignores options that precede the subcommand check (looks at first non-option)", () => {
    const r = splitClaudeArgs(["node", "ccairgap", "--config", "/tmp/x.yaml", "--", "--model", "opus"]);
    expect(r.argvForCommander).toEqual(["node", "ccairgap", "--config", "/tmp/x.yaml"]);
    expect(r.cliClaudeArgs).toEqual(["--model", "opus"]);
  });
});

describe("splitSelectedAgentArgs", () => {
  it("preserves launch passthrough after `--` as a raw ordered selected-agent tail", () => {
    const r = splitSelectedAgentArgs([
      "node",
      "ccairgap",
      "--agent",
      "codex",
      "--repo",
      ".",
      "--",
      "--model",
      "gpt-5",
      "initial prompt",
    ]);

    expect(r.argvForCommander).toEqual([
      "node",
      "ccairgap",
      "--agent",
      "codex",
      "--repo",
      ".",
    ]);
    expect(r.cliSelectedAgentArgs).toEqual(["--model", "gpt-5", "initial prompt"]);
  });

  it("keeps the backwards-compatible splitClaudeArgs wrapper", () => {
    const selected = splitSelectedAgentArgs(["node", "ccairgap", "--", "--model", "opus"]);
    const claude = splitClaudeArgs(["node", "ccairgap", "--", "--model", "opus"]);

    expect(claude).toEqual({
      argvForCommander: selected.argvForCommander,
      cliClaudeArgs: selected.cliSelectedAgentArgs,
    });
  });
});
