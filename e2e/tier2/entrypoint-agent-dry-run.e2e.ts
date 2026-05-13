import { describe, expect, it } from "vitest";
import { dockerAvailable } from "../helpers/dockerAvailable";
import { runEntrypointDryRun } from "../helpers/entrypointDryRun";

describe.skipIf(!(await dockerAvailable()))("entrypoint selected-agent dry-run", () => {
  it("reports the Claude branch and preserves passthrough argv", async () => {
    const out = await runEntrypointDryRun({
      agent: "claude",
      argv: ["--model", "opus", "prompt with spaces"],
    });

    expect(out).toContain("ccairgap-entrypoint-dry-run");
    expect(out).toContain("branch=claude");
    expect(out).toContain("CCAIRGAP_AGENT=claude");
    expect(out).toContain("cwd=/workspace/repo with spaces");
    expect(out).toContain("CODEX_HOME=/home/claude/.codex");
    expect(out).toContain("claude_home_ready=1");
    expect(out).toContain("codex_home_ready=1");
    expect(out).toContain("codex_sessions_ready=1");
    expect(out).toContain(
      "command=claude --dangerously-skip-permissions --model opus prompt\\ with\\ spaces",
    );
  });

  it("reports the Codex interactive branch", async () => {
    const out = await runEntrypointDryRun({
      agent: "codex",
      argv: ["--model", "gpt-5.5", "inspect this"],
    });

    expect(out).toContain("branch=codex");
    expect(out).toContain("CCAIRGAP_AGENT=codex");
    expect(out).not.toContain("CCAIRGAP_PRINT=");
    expect(out).toContain(
      "command=codex --dangerously-bypass-approvals-and-sandbox --cd /workspace/repo\\ with\\ spaces --model gpt-5.5 inspect\\ this",
    );
  });

  it("reports the Codex print branch with codex exec", async () => {
    const out = await runEntrypointDryRun({
      agent: "codex",
      print: "summarize status",
      argv: ["--json"],
    });

    expect(out).toContain("branch=codex");
    expect(out).toContain("CCAIRGAP_PRINT=summarize status");
    expect(out).toContain(
      "command=codex exec --dangerously-bypass-approvals-and-sandbox --cd /workspace/repo\\ with\\ spaces --json summarize\\ status",
    );
  });
});
