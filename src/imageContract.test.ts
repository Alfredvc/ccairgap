import { describe, expect, it } from "vitest";
import {
  inspectImageContract,
  type ImageContractRunner,
} from "./imageContract.js";

function runnerWithFailures(
  failures: string[] = [],
  versions = { codex: "codex-cli 0.134.0", claude: "2.1.143 (Claude Code)" },
): ImageContractRunner {
  return async (args) => {
    const command = args.join(" ");
    for (const failure of failures) {
      if (command.includes(failure)) {
        throw new Error(`simulated failure: ${failure}`);
      }
    }
    if (command.includes("codex --version")) {
      return { stdout: versions.codex };
    }
    if (command.includes("claude --version")) {
      return { stdout: versions.claude };
    }
    return { stdout: "" };
  };
}

describe("inspectImageContract", () => {
  it("passes when both agents, expected versions, mount targets, and permissions are present", async () => {
    const result = await inspectImageContract("ccairgap:test", {
      codexVersion: "0.134.0",
      claudeCodeVersion: "2.1.143",
      run: runnerWithFailures(),
    });

    expect(result).toEqual({ ok: true, findings: [] });
  });

  it("reports missing agent binaries", async () => {
    const result = await inspectImageContract("ccairgap:test", {
      codexVersion: "0.134.0",
      claudeCodeVersion: "2.1.143",
      run: runnerWithFailures(["command -v claude", "command -v codex"]),
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "missing-claude",
      "missing-codex",
    ]);
  });

  it("reports Codex versions that differ from the launch-resolved expectation", async () => {
    const result = await inspectImageContract("ccairgap:test", {
      codexVersion: "0.130.0",
      claudeCodeVersion: "2.1.143",
      run: runnerWithFailures([], { codex: "codex-cli 0.134.0", claude: "2.1.143 (Claude Code)" }),
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      code: "unsupported-codex-version",
      message: "image Codex version 0.134.0 does not match expected launch version 0.130.0",
    });
  });

  it("reports Claude versions that differ from the launch-resolved expectation", async () => {
    const result = await inspectImageContract("ccairgap:test", {
      codexVersion: "0.134.0",
      claudeCodeVersion: "2.1.142",
      run: runnerWithFailures([], { codex: "codex-cli 0.134.0", claude: "2.1.143 (Claude Code)" }),
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      code: "unsupported-claude-version",
      message: "image Claude Code version 2.1.143 does not match expected launch version 2.1.142",
    });
  });

  it("reports required mount target and UID-portable permission failures", async () => {
    const result = await inspectImageContract("ccairgap:test", {
      codexVersion: "0.134.0",
      claudeCodeVersion: "2.1.143",
      run: runnerWithFailures(["test -d /home/claude/.codex/sessions", "test -w /home/claude/.codex"]),
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("missing-codex-sessions");
    expect(result.findings.map((finding) => finding.code)).toContain("codex-home-not-uid-portable");
  });

  it("checks UID-portable permissions using the same runtime user posture as launch", async () => {
    const calls: string[][] = [];
    await inspectImageContract("ccairgap:test", {
      codexVersion: "0.134.0",
      claudeCodeVersion: "2.1.143",
      run: async (args) => {
        calls.push(args);
        if (args.includes("codex --version")) return { stdout: "codex-cli 0.134.0" };
        if (args.includes("claude --version")) return { stdout: "2.1.143 (Claude Code)" };
        return { stdout: "" };
      },
    });

    const writableChecks = calls.filter((args) => args.join(" ").includes("test -w "));
    expect(writableChecks.length).toBeGreaterThan(0);
    for (const args of writableChecks) {
      expect(args).toContain("--user");
      expect(args).toContain(`${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`);
    }
  });
});
