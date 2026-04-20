import { describe, expect, it } from "vitest";
import { classifyFlag, validateClaudeArgs } from "./claudeArgs.js";

describe("classifyFlag", () => {
  it("allows arbitrary unknown flags (forward-compat)", () => {
    expect(classifyFlag("--model").kind).toBe("allow");
    expect(classifyFlag("--effort").kind).toBe("allow");
    expect(classifyFlag("--brand-new-2027-flag").kind).toBe("allow");
  });

  it("hard-denies ccairgap-owned flags with a ccairgap-equivalent suggestion", () => {
    const name = classifyFlag("--name");
    expect(name.kind).toBe("hard");
    if (name.kind === "hard") expect(name.suggestion).toMatch(/ccairgap --name/);
    const resume = classifyFlag("--resume");
    if (resume.kind === "hard") expect(resume.suggestion).toMatch(/ccairgap --resume/);
    const print = classifyFlag("--print");
    if (print.kind === "hard") expect(print.suggestion).toMatch(/ccairgap --print/);
  });

  it("hard-denies the resume family", () => {
    for (const f of ["--continue", "--from-pr", "--fork-session", "--session-id"]) {
      expect(classifyFlag(f).kind).toBe("hard");
    }
  });

  it("hard-denies sandbox-broken flags", () => {
    for (const f of [
      "--ide",
      "--worktree",
      "--tmux",
      "--add-dir",
      "--plugin-dir",
      "--debug-file",
      "--mcp-config",
      "--strict-mcp-config",
      "--settings",
    ]) {
      expect(classifyFlag(f).kind).toBe("hard");
    }
  });

  it("hard-denies pointless-in-container flags", () => {
    for (const f of ["--help", "--version", "--chrome", "--no-chrome"]) {
      expect(classifyFlag(f).kind).toBe("hard");
    }
  });

  it("soft-drops --dangerously-skip-permissions and its allow- variant", () => {
    expect(classifyFlag("--dangerously-skip-permissions").kind).toBe("soft");
    expect(classifyFlag("--allow-dangerously-skip-permissions").kind).toBe("soft");
  });
});

describe("validateClaudeArgs — allow", () => {
  it("passes through allowed flags + values verbatim", () => {
    const r = validateClaudeArgs(["--model", "opus", "--effort", "high", "--verbose"], "cli");
    expect(r.filtered).toEqual(["--model", "opus", "--effort", "high", "--verbose"]);
    expect(r.hardDenied).toEqual([]);
    expect(r.softDropped).toEqual([]);
  });

  it("preserves --flag=value form unchanged", () => {
    const r = validateClaudeArgs(["--model=opus"], "cli");
    expect(r.filtered).toEqual(["--model=opus"]);
    expect(r.hardDenied).toEqual([]);
  });

  it("accepts empty input", () => {
    expect(validateClaudeArgs([], "merged")).toEqual({
      filtered: [],
      hardDenied: [],
      softDropped: [],
    });
  });
});

describe("validateClaudeArgs — hard deny", () => {
  it("flags ccairgap-owned long forms", () => {
    for (const tok of ["--name", "--resume", "--print"]) {
      const r = validateClaudeArgs([tok, "x"], "cli");
      expect(r.hardDenied).toHaveLength(1);
      expect(r.hardDenied[0]!.token).toBe(tok);
    }
  });

  it("flags ccairgap-owned short forms (-n, -r, -p)", () => {
    for (const tok of ["-n", "-r", "-p"]) {
      const r = validateClaudeArgs([tok, "x"], "cli");
      expect(r.hardDenied).toHaveLength(1);
      expect(r.hardDenied[0]!.token).toBe(tok);
    }
  });

  it("flags --flag=value form", () => {
    const r = validateClaudeArgs(["--name=foo"], "cli");
    expect(r.hardDenied).toHaveLength(1);
    expect(r.hardDenied[0]!.token).toBe("--name=foo");
    expect(r.hardDenied[0]!.canonical).toBe("--name");
  });

  it("flags short-inline form (-nfoo, -rfoo)", () => {
    for (const tok of ["-nfoo", "-rfoo", "-pfoo"]) {
      const r = validateClaudeArgs([tok], "cli");
      expect(r.hardDenied).toHaveLength(1);
      expect(r.hardDenied[0]!.token).toBe(tok);
    }
  });

  it("flags resume-family (--continue, --from-pr, --fork-session, --session-id, -c)", () => {
    for (const tok of ["--continue", "-c", "--from-pr", "--fork-session", "--session-id"]) {
      const r = validateClaudeArgs([tok, "x"], "cli");
      expect(r.hardDenied).toHaveLength(1);
    }
  });

  it("flags sandbox-broken (--add-dir, --plugin-dir, --mcp-config, --settings, -w)", () => {
    for (const tok of [
      "--ide",
      "--tmux",
      "-w",
      "--worktree",
      "--add-dir",
      "--plugin-dir",
      "--debug-file",
      "--mcp-config",
      "--strict-mcp-config",
      "--settings",
    ]) {
      const r = validateClaudeArgs([tok, "x"], "cli");
      expect(r.hardDenied).toHaveLength(1);
    }
  });

  it("flags pointless-in-container (-h, --help, -v, --version, --chrome, --no-chrome)", () => {
    for (const tok of ["-h", "--help", "-v", "--version", "--chrome", "--no-chrome"]) {
      const r = validateClaudeArgs([tok], "cli");
      expect(r.hardDenied).toHaveLength(1);
    }
  });

  it("error message attributes config source when source=config", () => {
    const r = validateClaudeArgs(["--name", "foo"], "config");
    expect(r.hardDenied[0]!.message).toMatch(/^ccairgap: config\.yaml: claude-args/);
  });

  it("error message has no config.yaml prefix when source=cli", () => {
    const r = validateClaudeArgs(["--name", "foo"], "cli");
    expect(r.hardDenied[0]!.message).not.toMatch(/config\.yaml/);
  });
});

describe("validateClaudeArgs — soft drop", () => {
  it("strips --dangerously-skip-permissions with a warning", () => {
    const r = validateClaudeArgs(["--dangerously-skip-permissions"], "cli");
    expect(r.filtered).toEqual([]);
    expect(r.softDropped).toHaveLength(1);
    expect(r.softDropped[0]!.token).toBe("--dangerously-skip-permissions");
    expect(r.softDropped[0]!.reason).toMatch(/already set/i);
  });

  it("strips --allow-dangerously-skip-permissions", () => {
    const r = validateClaudeArgs(["--allow-dangerously-skip-permissions"], "cli");
    expect(r.filtered).toEqual([]);
    expect(r.softDropped).toHaveLength(1);
  });
});

describe("validateClaudeArgs — value-taking flag tokenization", () => {
  it("--agent consumes its next token as a value (no false-positive on --add-dir)", () => {
    const r = validateClaudeArgs(["--agent", "--add-dir"], "cli");
    expect(r.hardDenied).toEqual([]);
    expect(r.filtered).toEqual(["--agent", "--add-dir"]);
  });

  it("unknown flag defaults to no-value (conservative): --add-dir afterwards still errors", () => {
    const r = validateClaudeArgs(["--unknown-new-flag", "--add-dir", "/host"], "cli");
    expect(r.hardDenied).toHaveLength(1);
    expect(r.hardDenied[0]!.canonical).toBe("--add-dir");
  });

  it("--agents JSON value with --not-a-flag substring is left alone", () => {
    const json = '{"foo": "--not-a-flag"}';
    const r = validateClaudeArgs(["--agents", json], "cli");
    expect(r.filtered).toEqual(["--agents", json]);
    expect(r.hardDenied).toEqual([]);
  });
});

describe("validateClaudeArgs — merge order", () => {
  it("preserves order across config + CLI concatenation (caller does the concat)", () => {
    const merged = ["--model", "opus", "--model", "sonnet"];
    const r = validateClaudeArgs(merged, "merged");
    expect(r.filtered).toEqual(merged);
  });
});
