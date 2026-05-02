import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mergeLayers } from "./configLayered.js";
import { loadIntegrationsDir, loadUserWideConfig, resolveUserWideDir } from "./userConfig.js";

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
    for (const entry of [
      { yamlKey: "repo", normKey: "repo", value: "foo" },
      { yamlKey: "name", normKey: "name", value: "foo" },
      { yamlKey: "mount", normKey: "mount", value: "[]" },
      { yamlKey: "cp", normKey: "cp", value: "[]" },
      { yamlKey: "sync", normKey: "sync", value: "[]" },
      { yamlKey: "extra-repo", normKey: "extraRepo", value: "[]" },
      { yamlKey: "ro", normKey: "ro", value: "[]" },
      { yamlKey: "base", normKey: "base", value: "foo" },
      { yamlKey: "dockerfile", normKey: "dockerfile", value: "foo" },
      { yamlKey: "docker-build-arg", normKey: "dockerBuildArg", value: "{}" },
      { yamlKey: "rebuild", normKey: "rebuild", value: "true" },
      { yamlKey: "print", normKey: "print", value: "foo" },
      { yamlKey: "resume", normKey: "resume", value: "foo" },
      { yamlKey: "clipboard", normKey: "clipboard", value: "true" },
      { yamlKey: "no-auto-memory", normKey: "noAutoMemory", value: "true" },
      { yamlKey: "no-preserve-dirty", normKey: "noPreserveDirty", value: "true" },
      { yamlKey: "warn-docker-args", normKey: "warnDockerArgs", value: "true" },
      { yamlKey: "claude-args", normKey: "claudeArgs", value: "[]" },
      { yamlKey: "keep-container", normKey: "keepContainer", value: "true" },
      { yamlKey: "refresh-below-ttl", normKey: "refreshBelowTtl", value: "10" },
    ]) {
      writeFileSync(
        join(dir, "x.yaml"),
        `${entry.yamlKey}: ${entry.value}\n`,
      );
      expect(() => loadIntegrationsDir(dir)).toThrow(
        new RegExp(`key '${entry.normKey}' not allowed in integration files`),
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

describe("loadUserWideConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccairgap-uw-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns undefined when dir absent", () => {
    expect(loadUserWideConfig("/no/such/dir")).toBeUndefined();
  });

  it("returns undefined when config.yaml absent", () => {
    expect(loadUserWideConfig(dir)).toBeUndefined();
  });

  it("loads + path-resolves config.yaml", () => {
    writeFileSync(
      join(dir, "config.yaml"),
      "extra-repo: [/abs/path]\ndockerfile: Dockerfile\n",
    );
    const r = loadUserWideConfig(dir)!;
    expect(r.path).toBe(join(dir, "config.yaml"));
    expect(r.config.extraRepo).toEqual(["/abs/path"]);
    expect(r.config.dockerfile).toBe(join(dir, "Dockerfile"));
  });

  it("hard-errors on relative repo", () => {
    writeFileSync(join(dir, "config.yaml"), "repo: relative/path\n");
    expect(() => loadUserWideConfig(dir)).toThrow(/relative paths not allowed/);
  });

  it("warns when <name>.config.yaml exists for active profile", () => {
    writeFileSync(join(dir, "web.config.yaml"), "name: foo\n");
    const warnings: string[] = [];
    loadUserWideConfig(dir, { activeProfile: "web", warn: (s) => warnings.push(s) });
    expect(warnings.some((w) => /web\.config\.yaml exists but user-wide profiles are not loaded/.test(w))).toBe(true);
  });

  it("does not warn when activeProfile undefined", () => {
    writeFileSync(join(dir, "web.config.yaml"), "name: foo\n");
    const warnings: string[] = [];
    loadUserWideConfig(dir, { warn: (s) => warnings.push(s) });
    expect(warnings).toEqual([]);
  });
});

describe("end-to-end layered load", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccairgap-e2e-"));
    mkdirSync(join(dir, "integrations"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("integrations + config.yaml + project merge with correct provenance", () => {
    writeFileSync(
      join(dir, "integrations", "switchboard.yaml"),
      "hooks:\n  enable: ['switchboard-*']\ndocker-run-arg:\n  - '-e SB=1'\n",
    );
    writeFileSync(
      join(dir, "config.yaml"),
      "extra-repo: [/abs/ref]\ndocker-run-arg:\n  - '-e USER=1'\n",
    );
    const integrations = loadIntegrationsDir(join(dir, "integrations"));
    const userWide = loadUserWideConfig(dir);
    const projectCfg = { dockerRunArg: ["-e PROJ=1"] };
    const result = mergeLayers({
      integrations: integrations.map((e) => ({ filename: e.filename, config: e.config })),
      userWide: userWide?.config,
      project: projectCfg,
    });
    expect(result.merged.hooks?.enable).toEqual(["switchboard-*"]);
    expect(result.merged.extraRepo).toEqual(["/abs/ref"]);
    expect(result.merged.dockerRunArg).toEqual(["-e SB=1", "-e USER=1", "-e PROJ=1"]);
    expect(result.provenance.dockerRunArg).toEqual([
      "user-wide-integration:switchboard.yaml",
      "user-wide",
      "project",
    ]);
  });
});
