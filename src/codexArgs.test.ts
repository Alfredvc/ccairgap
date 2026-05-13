import { describe, expect, it } from "vitest";
import { validateCodexArgs, type ValidateCodexArgsOptions } from "./codexArgs.js";

// Codex passthrough policy checked against local /Users/alfredvc/src/codex and upstream openai/codex on 2026-05-13:
// codex-rs/cli/src/main.rs, codex-rs/tui/src/cli.rs, codex-rs/utils/cli/src/shared_options.rs, codex-rs/exec/src/cli.rs.

const visibleRoot = "/workspace";
const visibleImage = "/workspace/assets/screenshot.png";
const hostOnlyImage = "/Users/alfredvc/Desktop/screenshot.png";

function validate(overrides: Partial<ValidateCodexArgsOptions> = {}): string[] {
  return validateCodexArgs({
    mode: { agent: "codex" },
    argv: [],
    visibleRoots: [visibleRoot],
    visiblePaths: [visibleImage],
    ...overrides,
  });
}

function expectDenied(argv: string[], message: RegExp, overrides: Partial<ValidateCodexArgsOptions> = {}): void {
  expect(() => validate({ argv, ...overrides })).toThrow(message);
}

describe("validateCodexArgs interactive allowlist", () => {
  it("accepts empty interactive passthrough", () => {
    expect(validate()).toEqual([]);
  });

  it("allows interactive safe flags and preserves order", () => {
    const argv = [
      "--image",
      visibleImage,
      "-i",
      visibleImage,
      "--model",
      "gpt-5-codex",
      "-m",
      "gpt-5-codex-mini",
      "--search",
      "--no-alt-screen",
    ];

    expect(validate({ argv })).toEqual(argv);
  });

  it("allows interactive inline model and image values", () => {
    const argv = [`--image=${visibleImage}`, `-i${visibleImage}`, "--model=gpt-5-codex", "-mgpt-5-codex-mini"];

    expect(validate({ argv })).toEqual(argv);
  });

  it("allows one optional positional prompt in interactive mode", () => {
    expect(validate({ argv: ["explain the changes"] })).toEqual(["explain the changes"]);
    expect(validate({ argv: ["--model", "gpt-5-codex", "explain the changes"] })).toEqual([
      "--model",
      "gpt-5-codex",
      "explain the changes",
    ]);
  });
});

describe("validateCodexArgs print allowlist", () => {
  const printMode = { agent: "codex" as const, print: "summarize" };

  it("allows print safe flags and preserves order", () => {
    const argv = [
      "--image",
      visibleImage,
      "-i",
      visibleImage,
      "--model",
      "gpt-5-codex",
      "-m",
      "gpt-5-codex-mini",
      "--output-schema",
      '{"type":"object"}',
      "--color",
      "always",
      "--output-last-message",
      "/workspace/last-message.txt",
      "-o",
      "/workspace/last-message-again.txt",
      "--json",
    ];

    expect(validate({ mode: printMode, argv })).toEqual(argv);
  });

  it("allows print inline values", () => {
    const argv = [
      `--image=${visibleImage}`,
      `-i${visibleImage}`,
      "--model=gpt-5-codex",
      "-mgpt-5-codex-mini",
      '--output-schema={"type":"object"}',
      "--color=always",
      "--output-last-message=/workspace/last-message.txt",
      "-o/workspace/last-message-again.txt",
      "--json",
    ];

    expect(validate({ mode: printMode, argv })).toEqual(argv);
  });
});

describe("validateCodexArgs denies top-level subcommands", () => {
  it("denies known top-level subcommands and aliases", () => {
    for (const token of [
      "exec",
      "e",
      "review",
      "login",
      "logout",
      "mcp",
      "plugin",
      "mcp-server",
      "app-server",
      "remote-control",
      "app",
      "completion",
      "update",
      "sandbox",
      "debug",
      "execpolicy",
      "apply",
      "a",
      "resume",
      "fork",
      "cloud",
      "cloud-tasks",
      "responses-api-proxy",
      "stdio-to-uds",
      "exec-server",
      "features",
    ]) {
      expectDenied([token], new RegExp(token.replaceAll("-", "-")));
    }
  });
});

describe("validateCodexArgs denies unsafe shared flags", () => {
  it("denies ccairgap-owned workspace/config/runtime policy flags", () => {
    for (const token of [
      "--cd",
      "-C",
      "--add-dir",
      "--config",
      "-c",
      "--profile",
      "-p",
      "--enable",
      "--disable",
      "--sandbox",
      "-s",
      "--ask-for-approval",
      "-a",
      "--remote",
      "--remote-auth-token-env",
      "--oss",
      "--local-provider",
    ]) {
      expectDenied([token], new RegExp(token));
    }
  });

  it("denies user-supplied bypass aliases", () => {
    for (const token of ["--dangerously-bypass-approvals-and-sandbox", "--yolo", "--full-auto"]) {
      expectDenied([token], new RegExp(token));
    }
  });
});

describe("validateCodexArgs denies print-mode exec unsafe flags", () => {
  const printMode = { agent: "codex" as const, print: "summarize" };

  it("denies exec-mode flags that bypass local user state or repository checks", () => {
    for (const token of ["--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--full-auto"]) {
      expectDenied([token], new RegExp(token), { mode: printMode });
    }
  });
});

describe("validateCodexArgs profile versus ccairgap print mode", () => {
  it("denies Codex profile flags in selected-agent tail", () => {
    expectDenied(["-p", "work"], /-p|--profile/);
    expectDenied(["--profile", "work"], /--profile/);
    expectDenied(["--profile=work"], /--profile/);
  });

  it("allows ccairgap print mode represented in AgentMode without a Codex profile flag", () => {
    const argv = ["--json"];
    expect(validate({ mode: { agent: "codex", print: "summarize" }, argv })).toEqual(argv);
  });
});

describe("validateCodexArgs fails closed", () => {
  it("rejects unknown long and short flags", () => {
    expectDenied(["--future-flag"], /--future-flag/);
    expectDenied(["-z"], /-z/);
  });

  it("rejects inline values on boolean flags", () => {
    expectDenied(["--search=false"], /--search=false/);
    expectDenied(["--no-alt-screen=false"], /--no-alt-screen=false/);
    expectDenied(["--json=false"], /--json=false/, { mode: { agent: "codex", print: "summarize" } });
  });

  it("rejects a bare separator token because ccairgap already consumed its separator", () => {
    expectDenied(["--"], /--/);
  });
});

describe("validateCodexArgs value handling", () => {
  it("rejects missing values for value-taking flags", () => {
    for (const token of ["--model", "-m", "--image", "-i"]) {
      expectDenied([token], new RegExp(token));
    }
    for (const token of ["--output-schema", "--color", "--output-last-message", "-o"]) {
      expectDenied([token], new RegExp(token), { mode: { agent: "codex", print: "summarize" } });
    }
  });

  it("rejects value-taking flags when the next token is another flag", () => {
    for (const token of ["--model", "-m", "--image", "-i"]) {
      expectDenied([token, "--json"], new RegExp(token));
    }
    for (const token of ["--output-schema", "--color", "--output-last-message", "-o"]) {
      expectDenied([token, "--json"], new RegExp(token), { mode: { agent: "codex", print: "summarize" } });
    }
  });
});

describe("validateCodexArgs positional prompt policy", () => {
  it("rejects more than one interactive positional prompt", () => {
    expectDenied(["first prompt", "second prompt"], /second prompt|positional/i);
  });

  it("rejects print-mode passthrough positional prompts", () => {
    expectDenied(["extra prompt"], /extra prompt|positional/i, { mode: { agent: "codex", print: "summarize" } });
  });
});

describe("validateCodexArgs image visibility", () => {
  it("accepts images under visible roots or explicitly visible paths", () => {
    expect(validate({ argv: ["--image", "/workspace/nested/image.png"] })).toEqual([
      "--image",
      "/workspace/nested/image.png",
    ]);
    expect(validate({ argv: ["--image", visibleImage], visibleRoots: [], visiblePaths: [visibleImage] })).toEqual([
      "--image",
      visibleImage,
    ]);
  });

  it("accepts comma-delimited image lists when every path is visible", () => {
    const imageList = `${visibleImage},/workspace/other.png`;
    expect(validate({ argv: ["--image", imageList] })).toEqual(["--image", imageList]);
  });

  it("accepts and validates repeated whitespace image values", () => {
    expect(validate({ argv: ["--image", visibleImage, "/workspace/other.png"] })).toEqual([
      "--image",
      visibleImage,
      "/workspace/other.png",
    ]);
  });

  it("rejects host-only image paths", () => {
    expectDenied(["--image", hostOnlyImage], /--image|visible|host/i);
    expectDenied([`--image=${hostOnlyImage}`], /--image|visible|host/i);
    expectDenied(["--image", `${visibleImage},${hostOnlyImage}`], /--image|visible|host/i);
    expectDenied(["--image", visibleImage, hostOnlyImage], /--image|visible|host/i);
  });

  it("rejects traversal outside visible roots", () => {
    expectDenied(["--image", "/workspace/../host-only.png"], /--image|visible|host/i);
  });
});
