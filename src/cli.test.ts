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

  it("allows -- passthrough on exec as an arbitrary command tail", () => {
    const r = splitSelectedAgentArgs([
      "node",
      "ccairgap",
      "exec",
      "--",
      "aharness",
      "x",
    ]);

    expect(r.argvForCommander).toEqual(["node", "ccairgap", "exec"]);
    expect(r.cliSelectedAgentArgs).toEqual(["aharness", "x"]);
  });

  it("allows global options before exec and preserves exec's arbitrary command tail", () => {
    const r = splitSelectedAgentArgs([
      "node",
      "ccairgap",
      "--config",
      "/tmp/config.yaml",
      "--agent",
      "codex",
      "exec",
      "--",
      "aharness",
      "x",
    ]);

    expect(r.argvForCommander).toEqual([
      "node",
      "ccairgap",
      "--config",
      "/tmp/config.yaml",
      "--agent",
      "codex",
      "exec",
    ]);
    expect(r.cliSelectedAgentArgs).toEqual(["aharness", "x"]);
  });

  it("does not classify a global option value equal to exec as the exec subcommand", () => {
    expect(() =>
      splitSelectedAgentArgs([
        "node",
        "ccairgap",
        "--config",
        "exec",
        "list",
        "--",
        "aharness",
        "x",
      ]),
    ).toThrow(/process\.exit\(1\)/);
    expect(errSpy.mock.calls[0]?.[0]).toMatch(
      /-- passthrough is only valid on the default launch command, not on subcommand 'list'/,
    );
  });

  it("still lets an unknown root positional reach Commander's unknown-command guard after an exec-valued option", () => {
    const r = splitSelectedAgentArgs([
      "node",
      "ccairgap",
      "--config",
      "exec",
      "lsit",
      "--",
      "aharness",
      "x",
    ]);

    expect(r.argvForCommander).toEqual(["node", "ccairgap", "--config", "exec", "lsit"]);
    expect(r.cliSelectedAgentArgs).toEqual(["aharness", "x"]);
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

describe("exec CLI routing", () => {
  const savedArgv = process.argv;
  let exitSpy: MockInstance;
  let errSpy: MockInstance;

  async function importCliWithMocks(
    args: string[],
    config: Record<string, unknown> = {},
  ) {
    await vi.resetModules();
    process.argv = ["node", "ccairgap", ...args];

    const launchMock = vi.fn(async () => ({
      exitCode: 0,
      id: "test-0000",
      sessionDir: "/tmp/ccairgap-test-session",
      imageTag: "ccairgap:test",
    }));
    const loadAllLayersMock = vi.fn(() => ({
      layered: { merged: config, provenance: {} },
      userWideDir: "/tmp/ccairgap-user",
    }));

    vi.doMock("./launch.js", () => ({ launch: launchMock }));
    vi.doMock("./configLayered.js", () => ({ loadAllLayers: loadAllLayersMock }));

    await import("./cli.js");
    await vi.waitFor(() => expect(launchMock).toHaveBeenCalled());

    return { launchMock, loadAllLayersMock };
  }

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.argv = savedArgv;
    exitSpy.mockRestore();
    errSpy.mockRestore();
    vi.doUnmock("./launch.js");
    vi.doUnmock("./configLayered.js");
  });

  it("keeps root launch selected-agent passthrough behavior", async () => {
    const { launchMock } = await importCliWithMocks([
      "--bare",
      "--",
      "--model",
      "opus",
    ]);

    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claude",
        execCommand: undefined,
        claudeArgs: ["--model", "opus"],
        codexArgs: [],
      }),
    );
  });

  it("routes exec's command tail separately from selected-agent args", async () => {
    const { launchMock } = await importCliWithMocks([
      "exec",
      "--agent",
      "codex",
      "--bare",
      "--",
      "aharness",
      "x",
    ]);

    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "codex",
        bare: true,
        execCommand: ["aharness", "x"],
        claudeArgs: [],
        codexArgs: [],
      }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("defaults exec to the Claude-selected environment", async () => {
    const { launchMock } = await importCliWithMocks([
      "exec",
      "--bare",
      "--",
      "aharness",
      "x",
    ]);

    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "claude",
        execCommand: ["aharness", "x"],
      }),
    );
  });

  it("uses config agent for exec unless CLI --agent overrides it", async () => {
    const configSelected = await importCliWithMocks(
      ["exec", "--bare", "--", "aharness"],
      { agent: "codex" },
    );
    expect(configSelected.launchMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "codex" }),
    );

    const cliOverride = await importCliWithMocks(
      ["exec", "--agent", "claude", "--bare", "--", "aharness"],
      { agent: "codex" },
    );
    expect(cliOverride.launchMock).toHaveBeenCalledWith(
      expect.objectContaining({ agent: "claude" }),
    );
  });

  it("warns and ignores config selected-agent args in exec mode", async () => {
    const { launchMock } = await importCliWithMocks(
      ["exec", "--bare", "--", "aharness"],
      {
        claudeArgs: ["--model", "opus"],
        codexArgs: ["--json"],
      },
    );

    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        execCommand: ["aharness"],
        claudeArgs: [],
        codexArgs: [],
      }),
    );
    expect(errSpy).toHaveBeenCalledWith(
      "ccairgap: warning: ignoring config claude-args/codex-args in exec mode",
    );
  });

  it.each([
    ["--no-warn-docker-args", { warnDockerArgs: false }],
    ["--no-clipboard", { clipboard: false }],
    ["--no-preserve-dirty", { noPreserveDirty: true }],
    ["--no-auto-memory", { noAutoMemory: true }],
  ])("honors root-position %s for exec", async (flag, expectedLaunchOptions) => {
    const { launchMock } = await importCliWithMocks([
      flag,
      "exec",
      "--bare",
      "--",
      "aharness",
    ]);

    expect(launchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        execCommand: ["aharness"],
        ...expectedLaunchOptions,
      }),
    );
  });
});
