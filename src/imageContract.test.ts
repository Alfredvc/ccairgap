import { describe, expect, it } from "vitest";
import {
  inspectImageContract,
  type ImageContractRunner,
} from "./imageContract.js";

function runnerWithFailures(failures: string[] = [], version = "codex-cli 0.130.0"): ImageContractRunner {
  return async (args) => {
    const command = args.join(" ");
    for (const failure of failures) {
      if (command.includes(failure)) {
        throw new Error(`simulated failure: ${failure}`);
      }
    }
    if (command.includes("codex --version")) {
      return { stdout: version };
    }
    return { stdout: "" };
  };
}

describe("inspectImageContract", () => {
  it("passes when both agents, supported Codex, mount targets, and permissions are present", async () => {
    const result = await inspectImageContract("ccairgap:test", {
      run: runnerWithFailures(),
    });

    expect(result).toEqual({ ok: true, findings: [] });
  });

  it("reports missing agent binaries", async () => {
    const result = await inspectImageContract("ccairgap:test", {
      run: runnerWithFailures(["command -v claude", "command -v codex"]),
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual([
      "missing-claude",
      "missing-codex",
    ]);
  });

  it("reports unsupported Codex versions", async () => {
    const result = await inspectImageContract("ccairgap:test", {
      run: runnerWithFailures([], "codex-cli 0.129.0"),
    });

    expect(result.ok).toBe(false);
    expect(result.findings).toContainEqual({
      code: "unsupported-codex-version",
      message: "image Codex version 0.129.0 is not supported; expected 0.130.0",
    });
  });

  it("reports required mount target and UID-portable permission failures", async () => {
    const result = await inspectImageContract("ccairgap:test", {
      run: runnerWithFailures(["test -d /home/claude/.codex/sessions", "test -w /home/claude/.codex"]),
    });

    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toContain("missing-codex-sessions");
    expect(result.findings.map((finding) => finding.code)).toContain("codex-home-not-uid-portable");
  });
});
