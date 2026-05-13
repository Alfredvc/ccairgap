import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { resolveCodexHome, UnsafeCodexHomeError } from "./codexHome.js";

describe("resolveCodexHome", () => {
  it("uses CODEX_HOME when set and records an absolute path", () => {
    const plan = resolveCodexHome({
      env: { CODEX_HOME: "relative-codex", HOME: "/tmp/home" },
    });

    expect(plan).toEqual({ hostHome: resolve("relative-codex"), source: "env" });
  });

  it("falls back to ~/.codex", () => {
    const plan = resolveCodexHome({ env: { HOME: "/tmp/example-home" } });

    expect(plan).toEqual({
      hostHome: "/tmp/example-home/.codex",
      source: "default",
    });
  });

  it("rejects a Codex home inside a protected workspace", () => {
    expect(() =>
      resolveCodexHome({
        env: { CODEX_HOME: join("/workspace/repo", ".codex") },
        protectedHostPaths: ["/workspace/repo"],
      }),
    ).toThrow(UnsafeCodexHomeError);
  });
});
