import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadIntegrationsDir, resolveUserWideDir } from "./userConfig.js";

describe("resolveUserWideDir", () => {
  it("uses XDG_CONFIG_HOME when set", () => {
    expect(
      resolveUserWideDir({ env: { XDG_CONFIG_HOME: "/x/cfg" }, home: "/h" }),
    ).toBe("/x/cfg/ccairgap");
  });

  it("falls back to $HOME/.config/ccairgap", () => {
    expect(resolveUserWideDir({ env: {}, home: "/h" })).toBe(
      "/h/.config/ccairgap",
    );
  });

  it("ignores empty XDG_CONFIG_HOME (treat as unset)", () => {
    expect(
      resolveUserWideDir({ env: { XDG_CONFIG_HOME: "" }, home: "/h" }),
    ).toBe("/h/.config/ccairgap");
  });
});

describe("loadIntegrationsDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccairgap-int-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns empty array when dir absent", () => {
    expect(loadIntegrationsDir("/no/such/path")).toEqual([]);
  });

  it("returns empty array when dir empty", () => {
    expect(loadIntegrationsDir(dir)).toEqual([]);
  });

  it("loads in lexical order", () => {
    writeFileSync(join(dir, "b.yaml"), "hooks:\n  enable: ['b-*']\n");
    writeFileSync(join(dir, "a.yaml"), "hooks:\n  enable: ['a-*']\n");
    const out = loadIntegrationsDir(dir);
    expect(out.map((e) => e.filename)).toEqual(["a.yaml", "b.yaml"]);
    expect(out[0]!.config.hooks?.enable).toEqual(["a-*"]);
  });

  it("ignores non-.yaml files (.yml, README, dotfiles)", () => {
    writeFileSync(join(dir, "ok.yaml"), "hooks: { enable: ['x'] }\n");
    writeFileSync(join(dir, "skip.yml"), "hooks: { enable: ['y'] }\n");
    writeFileSync(join(dir, "README"), "noop");
    writeFileSync(join(dir, ".DS_Store"), "noop");
    const out = loadIntegrationsDir(dir);
    expect(out.map((e) => e.filename)).toEqual(["ok.yaml"]);
  });

  it("rejects forbidden top-level keys (repo, name, mount, cp, etc.)", () => {
    for (const [yamlKey, normKey] of [
      ["repo", "repo"],
      ["name", "name"],
      ["mount", "mount"],
      ["cp", "cp"],
      ["sync", "sync"],
      ["extra-repo", "extraRepo"],
      ["ro", "ro"],
      ["base", "base"],
      ["dockerfile", "dockerfile"],
      ["docker-build-arg", "dockerBuildArg"],
      ["rebuild", "rebuild"],
      ["print", "print"],
      ["resume", "resume"],
      ["clipboard", "clipboard"],
      ["no-auto-memory", "noAutoMemory"],
      ["no-preserve-dirty", "noPreserveDirty"],
      ["warn-docker-args", "warnDockerArgs"],
      ["claude-args", "claudeArgs"],
      ["keep-container", "keepContainer"],
      ["refresh-below-ttl", "refreshBelowTtl"],
    ] as const) {
      writeFileSync(
        join(dir, "x.yaml"),
        `${yamlKey}: ${yamlKey === "extra-repo" || yamlKey === "ro" || yamlKey === "cp" || yamlKey === "sync" || yamlKey === "mount" || yamlKey === "claude-args" ? "[]" : yamlKey === "docker-build-arg" ? "{}" : yamlKey === "rebuild" || yamlKey === "clipboard" || yamlKey === "no-auto-memory" || yamlKey === "no-preserve-dirty" || yamlKey === "warn-docker-args" || yamlKey === "keep-container" ? "true" : yamlKey === "refresh-below-ttl" ? "10" : "foo"}\n`,
      );
      expect(() => loadIntegrationsDir(dir)).toThrow(
        new RegExp(`key '${normKey}' not allowed in integration files`),
      );
    }
  });

  it("accepts hooks.enable, mcp.enable, docker-run-arg only", () => {
    writeFileSync(
      join(dir, "ok.yaml"),
      "hooks: { enable: ['a'] }\nmcp: { enable: ['b'] }\ndocker-run-arg: ['-e FOO=1']\n",
    );
    const out = loadIntegrationsDir(dir);
    expect(out[0]!.config).toMatchObject({
      hooks: { enable: ["a"] },
      mcp: { enable: ["b"] },
      dockerRunArg: ["-e FOO=1"],
    });
  });

  it("integration docker-run-arg passes safe-flag allowlist (rejects -v)", () => {
    writeFileSync(join(dir, "bad.yaml"), "docker-run-arg: ['-v /:/host']\n");
    expect(() => loadIntegrationsDir(dir)).toThrow(
      /-v.* not in safe allowlist/,
    );
  });

  it("integration docker-run-arg accepts -e KEY=VAL and --add-host", () => {
    writeFileSync(
      join(dir, "ok.yaml"),
      "docker-run-arg: ['-e FOO=1', '--add-host x:1.2.3.4']\n",
    );
    expect(() => loadIntegrationsDir(dir)).not.toThrow();
  });

  it("yaml parse error names the file", () => {
    writeFileSync(join(dir, "bad.yaml"), "::: not yaml\n");
    expect(() => loadIntegrationsDir(dir)).toThrow(/bad\.yaml/);
  });

  it("type mismatch in hooks.enable names the file", () => {
    writeFileSync(join(dir, "bad.yaml"), "hooks:\n  enable: 'not-array'\n");
    expect(() => loadIntegrationsDir(dir)).toThrow(/bad\.yaml/);
  });
});
