import { afterEach, describe, expect, it, vi } from "vitest";
import { computeTag, defaultDockerfile, registryRef } from "./image.js";

describe("computeTag", () => {
  it("default Dockerfile path → ccairgap:<v>-<hash8>", () => {
    const tag = computeTag(defaultDockerfile(), defaultDockerfile());
    expect(tag).toMatch(/^ccairgap:\d+\.\d+\.\d+(?:-[\w.]+)?-[0-9a-f]{8}$/);
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
