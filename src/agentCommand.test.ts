import { describe, expect, it } from "vitest";
import {
  agentCommandPlan,
  validatedAgentArgv,
  type ValidatedAgentArgv,
} from "./agentCommand.js";

describe("agentCommandPlan", () => {
  it("plans Claude interactive argv without changing the provider tail", () => {
    const argv = validatedAgentArgv(["--model", "sonnet", "--allowed-tools", "Bash"]);

    expect(agentCommandPlan({ agent: "claude" }, argv)).toEqual({
      agent: "claude",
      env: { CCAIRGAP_AGENT: "claude" },
      argv: ["--model", "sonnet", "--allowed-tools", "Bash"],
    });
  });

  it("plans Claude print mode through CCAIRGAP_PRINT and preserves argv tail shape", () => {
    const argv = validatedAgentArgv(["--output-format", "json"]);

    expect(agentCommandPlan({ agent: "claude", print: "summarize this diff" }, argv)).toEqual({
      agent: "claude",
      env: {
        CCAIRGAP_AGENT: "claude",
        CCAIRGAP_PRINT: "summarize this diff",
      },
      argv: ["--output-format", "json"],
    });
  });

  it("plans Codex interactive mode with only the validated argv tail", () => {
    const argv = validatedAgentArgv(["--model", "gpt-5-codex", "review the repo"]);

    expect(agentCommandPlan({ agent: "codex" }, argv)).toEqual({
      agent: "codex",
      env: { CCAIRGAP_AGENT: "codex" },
      argv: ["--model", "gpt-5-codex", "review the repo"],
    });
  });

  it("plans Codex print mode with prompt in env and validated argv separate", () => {
    const argv = validatedAgentArgv(["--json", "--model", "gpt-5-codex"]);

    expect(agentCommandPlan({ agent: "codex", print: "summarize" }, argv)).toEqual({
      agent: "codex",
      env: {
        CCAIRGAP_AGENT: "codex",
        CCAIRGAP_PRINT: "summarize",
      },
      argv: ["--json", "--model", "gpt-5-codex"],
    });
  });

  it("copies validated argv so later mutation cannot change the plan", () => {
    const argv = validatedAgentArgv(["--model", "sonnet"]);
    const plan = agentCommandPlan({ agent: "claude" }, argv);

    argv.push("--dangerously-skip-permissions");

    expect(plan.argv).toEqual(["--model", "sonnet"]);
  });

  it("rejects raw argv even when it is cast to the branded type", () => {
    const raw = ["--model", "gpt-5-codex"] as unknown as ValidatedAgentArgv;

    expect(() => agentCommandPlan({ agent: "codex" }, raw)).toThrow(
      /agent argv must come from validatedAgentArgv/,
    );
  });
});
