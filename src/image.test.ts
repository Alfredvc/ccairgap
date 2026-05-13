import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUPPORTED_CODEX_VERSION,
  computeTag,
  defaultDockerfile,
  defaultImageBuildArgs,
  normalizeCodexVersion,
  registryRef,
  validateExpectedCodexVersion,
} from "./image.js";

describe("computeTag", () => {
  it("default Dockerfile path → ccairgap:<v>-<hash8>", () => {
    const tag = computeTag(defaultDockerfile(), defaultDockerfile());
    expect(tag).toMatch(/^ccairgap:\d+\.\d+\.\d+(?:-[\w.]+)?-[0-9a-f]{8}$/);
  });

  it("custom Dockerfile tags depend on Dockerfile content only, not build args", () => {
    const dir = mkdtempSync(join(tmpdir(), "ccairgap-image-test-"));
    const dockerfile = join(dir, "Dockerfile");
    writeFileSync(dockerfile, "FROM scratch\n");

    const tag = computeTag(dockerfile, defaultDockerfile());

    expect(tag).toMatch(/^ccairgap:custom-[0-9a-f]{12}$/);
    expect(tag).toBe(computeTag(dockerfile, defaultDockerfile()));
  });
});

describe("Codex image version helpers", () => {
  it("normalizes codex --version output", () => {
    expect(normalizeCodexVersion("codex-cli 0.130.0")).toBe("0.130.0");
    expect(normalizeCodexVersion("0.130.0")).toBe("0.130.0");
    expect(normalizeCodexVersion("codex-cli 0.131.0-alpha.1")).toBe("0.131.0-alpha.1");
    expect(normalizeCodexVersion("not a version")).toBeUndefined();
  });

  it("defaults Docker build args for both agents and lets explicit build args override", () => {
    expect(defaultImageBuildArgs({ claudeVersion: "1.2.3" })).toEqual({
      CLAUDE_CODE_VERSION: "1.2.3",
      CODEX_VERSION: SUPPORTED_CODEX_VERSION,
    });

    expect(
      defaultImageBuildArgs({
        claudeVersion: "1.2.3",
        overrides: { CLAUDE_CODE_VERSION: "latest", CODEX_VERSION: "0.130.0-alpha.1" },
      }),
    ).toEqual({
      CLAUDE_CODE_VERSION: "latest",
      CODEX_VERSION: "0.130.0-alpha.1",
    });
  });

  it("rejects unsupported exact Codex version pins before image resolution", () => {
    expect(validateExpectedCodexVersion("0.130.0")).toEqual({
      ok: true,
      version: "0.130.0",
    });
    expect(validateExpectedCodexVersion("0.129.0")).toEqual({
      ok: false,
      version: "0.129.0",
      message: "unsupported CODEX_VERSION 0.129.0; supported exact version is 0.130.0",
    });
  });

  it("warns for non-exact Codex version inputs that require runtime inspection", () => {
    expect(validateExpectedCodexVersion("latest")).toEqual({
      ok: true,
      message:
        "CODEX_VERSION latest is not an exact supported semver; runtime image contract inspection must verify the installed Codex version",
    });
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
