import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeTag,
  defaultDockerfile,
  defaultImageBuildArgs,
  hostCodexVersion,
  normalizeClaudeVersion,
  normalizeCodexVersion,
  registryRef,
  parseAgentVersionsEnv,
  readPinnedAgentVersions,
  resolveAgentVersions,
  validateExpectedCodexVersion,
} from "./image.js";

describe("computeTag", () => {
  const versions = {
    claudeCodeVersion: "2.1.143",
    codexVersion: "0.134.0",
  };

  it("default Dockerfile path → ccairgap:<v>-<hash8>", () => {
    const tag = computeTag(defaultDockerfile(), defaultDockerfile(), versions);
    expect(tag).toMatch(/^ccairgap:\d+\.\d+\.\d+(?:-[\w.]+)?-[0-9a-f]{8}$/);
  });

  it("custom Dockerfile path → ccairgap:custom-<hash12>", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccairgap-image-test-"));
    const dockerfile = join(dir, "Dockerfile");
    writeFileSync(dockerfile, "FROM scratch\n");

    const tag = computeTag(dockerfile, defaultDockerfile(), versions);

    expect(tag).toMatch(/^ccairgap:custom-[0-9a-f]{12}$/);
    expect(tag).toBe(computeTag(dockerfile, defaultDockerfile(), versions));
  });

  it("changes default and custom tags when only Claude Code version changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccairgap-image-test-"));
    const dockerfile = join(dir, "Dockerfile");
    writeFileSync(dockerfile, "FROM scratch\n");

    const changedClaude = { ...versions, claudeCodeVersion: "2.1.144" };

    expect(computeTag(defaultDockerfile(), defaultDockerfile(), changedClaude)).not.toBe(
      computeTag(defaultDockerfile(), defaultDockerfile(), versions),
    );
    expect(computeTag(dockerfile, defaultDockerfile(), changedClaude)).not.toBe(
      computeTag(dockerfile, defaultDockerfile(), versions),
    );
  });

  it("changes default and custom tags when only Codex version changes", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccairgap-image-test-"));
    const dockerfile = join(dir, "Dockerfile");
    writeFileSync(dockerfile, "FROM scratch\n");

    const changedCodex = { ...versions, codexVersion: "0.135.0" };

    expect(computeTag(defaultDockerfile(), defaultDockerfile(), changedCodex)).not.toBe(
      computeTag(defaultDockerfile(), defaultDockerfile(), versions),
    );
    expect(computeTag(dockerfile, defaultDockerfile(), changedCodex)).not.toBe(
      computeTag(dockerfile, defaultDockerfile(), versions),
    );
  });

  it("keeps tags stable when version object keys are reordered", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccairgap-image-test-"));
    const dockerfile = join(dir, "Dockerfile");
    writeFileSync(dockerfile, "FROM scratch\n");
    const reordered = {
      codexVersion: versions.codexVersion,
      claudeCodeVersion: versions.claudeCodeVersion,
    };

    expect(computeTag(defaultDockerfile(), defaultDockerfile(), reordered)).toBe(
      computeTag(defaultDockerfile(), defaultDockerfile(), versions),
    );
    expect(computeTag(dockerfile, defaultDockerfile(), reordered)).toBe(
      computeTag(dockerfile, defaultDockerfile(), versions),
    );
  });
});

describe("Codex image version helpers", () => {
  it("normalizes claude --version output", () => {
    expect(normalizeClaudeVersion("2.1.143 (Claude Code)")).toBe("2.1.143");
    expect(normalizeClaudeVersion("2.1.143")).toBe("2.1.143");
    expect(normalizeClaudeVersion("2.1.144-alpha.1 (Claude Code)")).toBe("2.1.144-alpha.1");
    expect(normalizeClaudeVersion("not a version")).toBeUndefined();
  });

  it("normalizes codex --version output", () => {
    expect(normalizeCodexVersion("codex-cli 0.130.0")).toBe("0.130.0");
    expect(normalizeCodexVersion("0.130.0")).toBe("0.130.0");
    expect(normalizeCodexVersion("codex-cli 0.131.0-alpha.1")).toBe("0.131.0-alpha.1");
    expect(normalizeCodexVersion("not a version")).toBeUndefined();
  });

  it("defaults Docker build args from exact resolved versions and lets explicit build args override", () => {
    expect(defaultImageBuildArgs({ claudeVersion: "1.2.3", codexVersion: "0.134.0" })).toEqual({
      CLAUDE_CODE_VERSION: "1.2.3",
      CODEX_VERSION: "0.134.0",
    });

    expect(
      defaultImageBuildArgs({
        claudeVersion: "1.2.3",
        codexVersion: "0.134.0",
        overrides: { CLAUDE_CODE_VERSION: "2.0.0", CODEX_VERSION: "0.134.0-alpha.1" },
      }),
    ).toEqual({
      CLAUDE_CODE_VERSION: "2.0.0",
      CODEX_VERSION: "0.134.0-alpha.1",
    });
  });

  it("accepts exact Codex version pins before image resolution", () => {
    expect(validateExpectedCodexVersion("0.130.0")).toEqual({
      ok: true,
      version: "0.130.0",
    });
    expect(validateExpectedCodexVersion("0.134.0")).toEqual({
      ok: true,
      version: "0.134.0",
    });
  });

  it("rejects non-exact Codex version inputs before image resolution", () => {
    expect(validateExpectedCodexVersion("latest")).toEqual({
      ok: false,
      message: "CODEX_VERSION latest is not exact; pass an exact --docker-build-arg CODEX_VERSION=x.y.z",
    });
  });

  it("resolves omitted agent build args from injected host versions", async () => {
    await expect(
      resolveAgentVersions(
        {},
        {
          claudeCodeVersion: async () => "2.1.143",
          codexVersion: async () => "0.134.0",
        },
      ),
    ).resolves.toEqual({
      claudeCodeVersion: "2.1.143",
      codexVersion: "0.134.0",
    });
  });

  it("keeps exact agent build args without calling host readers", async () => {
    const hostReaders = {
      claudeCodeVersion: vi.fn(async () => "2.1.143"),
      codexVersion: vi.fn(async () => "0.134.0"),
    };

    await expect(
      resolveAgentVersions(
        { CLAUDE_CODE_VERSION: "2.0.0", CODEX_VERSION: "0.133.0" },
        hostReaders,
      ),
    ).resolves.toEqual({
      claudeCodeVersion: "2.0.0",
      codexVersion: "0.133.0",
    });
    expect(hostReaders.claudeCodeVersion).not.toHaveBeenCalled();
    expect(hostReaders.codexVersion).not.toHaveBeenCalled();
  });

  it("rejects non-exact explicit agent build args", async () => {
    await expect(
      resolveAgentVersions(
        { CLAUDE_CODE_VERSION: "2.1", CODEX_VERSION: "0.134.0" },
        {
          claudeCodeVersion: async () => "2.1.143",
          codexVersion: async () => "0.134.0",
        },
      ),
    ).rejects.toThrow(
      "CLAUDE_CODE_VERSION 2.1 is not exact; pass an exact --docker-build-arg CLAUDE_CODE_VERSION=x.y.z",
    );
  });

  it("rejects explicit latest agent build args", async () => {
    await expect(
      resolveAgentVersions(
        { CLAUDE_CODE_VERSION: "latest", CODEX_VERSION: "0.134.0" },
        {
          claudeCodeVersion: async () => "2.1.143",
          codexVersion: async () => "0.134.0",
        },
      ),
    ).rejects.toThrow(
      "CLAUDE_CODE_VERSION latest is not exact; pass an exact --docker-build-arg CLAUDE_CODE_VERSION=x.y.z",
    );
  });

  it("uses the release pin for an agent missing on the host (Claude-only host)", async () => {
    await expect(
      resolveAgentVersions(
        {},
        { claudeCodeVersion: async () => "2.1.316", codexVersion: async () => undefined },
        () => ({ CLAUDE_CODE_VERSION: "2.1.300", CODEX_VERSION: "0.166.0" }),
      ),
    ).resolves.toEqual({ claudeCodeVersion: "2.1.316", codexVersion: "0.166.0" });
  });

  it("uses the release pin for an agent missing on the host (Codex-only host)", async () => {
    await expect(
      resolveAgentVersions(
        {},
        { claudeCodeVersion: async () => undefined, codexVersion: async () => "0.170.0" },
        () => ({ CLAUDE_CODE_VERSION: "2.1.316", CODEX_VERSION: "0.166.0" }),
      ),
    ).resolves.toEqual({ claudeCodeVersion: "2.1.316", codexVersion: "0.170.0" });
  });

  it("prefers the host version over the release pin", async () => {
    await expect(
      resolveAgentVersions(
        {},
        { claudeCodeVersion: async () => "2.1.200", codexVersion: async () => "0.150.0" },
        () => ({ CLAUDE_CODE_VERSION: "2.1.316", CODEX_VERSION: "0.166.0" }),
      ),
    ).resolves.toEqual({ claudeCodeVersion: "2.1.200", codexVersion: "0.150.0" });
  });

  it("rejects omitted versions when neither the host nor the pin gives an exact version", async () => {
    await expect(
      resolveAgentVersions(
        {},
        { claudeCodeVersion: async () => undefined, codexVersion: async () => "0.134.0" },
        () => ({ CLAUDE_CODE_VERSION: "latest" }),
      ),
    ).rejects.toThrow(
      "CLAUDE_CODE_VERSION could not resolve: no exact host version and no exact release pin in docker/agent-versions.env; pass an exact --docker-build-arg CLAUDE_CODE_VERSION=x.y.z",
    );
  });

  it("parses docker/agent-versions.env and reads the bundled pins", () => {
    expect(
      parseAgentVersionsEnv("# comment\nCLAUDE_CODE_VERSION=2.1.316\n\nCODEX_VERSION=0.166.0\nOTHER=x\n"),
    ).toEqual({ CLAUDE_CODE_VERSION: "2.1.316", CODEX_VERSION: "0.166.0" });
    const pins = readPinnedAgentVersions();
    expect(pins.CLAUDE_CODE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
    expect(pins.CODEX_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("exports a host Codex version reader", () => {
    expect(hostCodexVersion).toEqual(expect.any(Function));
  });
});

describe("registryRef", () => {
  const origEnv = process.env.CCAIRGAP_REGISTRY;
  afterEach(() => {
    if (origEnv === undefined) delete process.env.CCAIRGAP_REGISTRY;
    else process.env.CCAIRGAP_REGISTRY = origEnv;
    vi.unstubAllEnvs();
  });

  it("default repo when CCAIRGAP_REGISTRY is unset", () => {
    delete process.env.CCAIRGAP_REGISTRY;
    expect(registryRef("ccairgap:0.5.0-abcdef12")).toBe(
      "ghcr.io/alfredvc/ccairgap:0.5.0-abcdef12",
    );
  });

  it("honors CCAIRGAP_REGISTRY override", () => {
    process.env.CCAIRGAP_REGISTRY = "registry.example.com/team/ccairgap";
    expect(registryRef("ccairgap:0.5.0-abcdef12")).toBe(
      "registry.example.com/team/ccairgap:0.5.0-abcdef12",
    );
  });

  it("returns undefined for custom-Dockerfile tags (never published)", () => {
    expect(registryRef("ccairgap:custom-abcdef123456")).toBeUndefined();
  });

  it("returns undefined for non-ccairgap tags", () => {
    expect(registryRef("someother:1.0")).toBeUndefined();
  });
});

describe("ensureImage", () => {
  afterEach(async () => {
    vi.doUnmock("execa");
    await vi.resetModules();
  });

  it("sends registry pull progress to stderr, because stdout carries print-mode output", async () => {
    await vi.resetModules();
    const execa = vi.fn(async () => ({ stdout: "" }));
    vi.doMock("execa", () => ({ execa }));
    const mod = await import("./image.js");

    expect(await mod.tryPullImage("local:1", "ghcr.io/x:1")).toBe(true);

    expect(execa).toHaveBeenCalledWith("docker", ["pull", "ghcr.io/x:1"], { stdio: ["ignore", 2, 2] });
  });

  it("builds a managed-runtime custom Dockerfile on the resolved runtime base image", async () => {
    await vi.resetModules();
    const execa = vi.fn(async (_cmd: string, args: string[]) => {
      if (args[0] === "image" && args[1] === "inspect") {
        throw new Error("missing image");
      }
      if (args[0] === "pull") {
        throw new Error("registry unavailable");
      }
      return { stdout: "" };
    });
    vi.doMock("execa", () => ({ execa }));
    const mod = await import("./image.js");
    const dir = mkdtempSync(join(tmpdir(), "ccairgap-image-test-"));
    const dockerfile = join(dir, "Dockerfile");
    writeFileSync(
      dockerfile,
      [
        "ARG CCAIRGAP_RUNTIME_BASE_IMAGE=ccairgap:runtime-base-required",
        "FROM ${CCAIRGAP_RUNTIME_BASE_IMAGE}",
        "RUN true",
        "",
      ].join("\n"),
    );
    const versions = {
      claudeCodeVersion: "2.1.143",
      codexVersion: "0.134.0",
    };
    const buildArgs = {
      CLAUDE_CODE_VERSION: versions.claudeCodeVersion,
      CODEX_VERSION: versions.codexVersion,
    };
    await mod.ensureImage({
      dockerfile,
      versions,
      buildArgs,
      rebuild: false,
    });

    const buildCalls = execa.mock.calls.filter(
      ([cmd, args]) => cmd === "docker" && args[0] === "build",
    );
    expect(buildCalls).toHaveLength(2);
    const runtimeBuild = buildCalls[0]!;
    const customBuild = buildCalls[1]!;
    expect(runtimeBuild[1]).toContain("--target");
    expect(runtimeBuild[1]).toContain("ccairgap-runtime");
    expect(customBuild[1]).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^CCAIRGAP_RUNTIME_BASE_IMAGE=ccairgap:.+-runtime-[0-9a-f]{8}$/),
      ]),
    );
    expect(customBuild[1]).toContain("CLAUDE_CODE_VERSION=2.1.143");
    expect(customBuild[1]).toContain("CODEX_VERSION=0.134.0");
  });
});
