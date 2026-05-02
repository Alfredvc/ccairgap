import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAllLayers, mergeLayers } from "./configLayered.js";

describe("mergeLayers", () => {
  it("scalars: project wins over user-wide; user-wide wins over integration", () => {
    const r = mergeLayers({
      integrations: [{ filename: "a.yaml", config: { name: "int" } }],
      userWide: { name: "uw" },
      project: { name: "proj" },
    });
    expect(r.merged.name).toBe("proj");
    expect(r.provenance.name).toBe("project");
  });

  it("scalars: user-wide wins when project absent", () => {
    const r = mergeLayers({
      integrations: [],
      userWide: { name: "uw" },
      project: undefined,
    });
    expect(r.merged.name).toBe("uw");
    expect(r.provenance.name).toBe("user-wide");
  });

  it("scalars: integration wins when user-wide and project absent", () => {
    const r = mergeLayers({
      integrations: [{ filename: "a.yaml", config: { hooks: { enable: ["x"] } } }],
      userWide: undefined,
      project: undefined,
    });
    expect(r.merged.hooks?.enable).toEqual(["x"]);
  });

  it("arrays: concat in load order, no dedup", () => {
    const r = mergeLayers({
      integrations: [
        { filename: "a.yaml", config: { dockerRunArg: ["a1"] } },
        { filename: "b.yaml", config: { dockerRunArg: ["b1"] } },
      ],
      userWide: { dockerRunArg: ["uw1"] },
      project: { dockerRunArg: ["p1"] },
    });
    expect(r.merged.dockerRunArg).toEqual(["a1", "b1", "uw1", "p1"]);
    expect(r.provenance.dockerRunArg).toEqual([
      "user-wide-integration:a.yaml",
      "user-wide-integration:b.yaml",
      "user-wide",
      "project",
    ]);
  });

  it("hooks.enable: concat across layers", () => {
    const r = mergeLayers({
      integrations: [
        { filename: "a.yaml", config: { hooks: { enable: ["a-*"] } } },
      ],
      userWide: { hooks: { enable: ["uw-*"] } },
      project: { hooks: { enable: ["p-*"] } },
    });
    expect(r.merged.hooks?.enable).toEqual(["a-*", "uw-*", "p-*"]);
  });

  it("dockerBuildArg: per-key merge, project wins on collision", () => {
    const r = mergeLayers({
      integrations: [],
      userWide: { dockerBuildArg: { K: "uw", U: "uw" } },
      project: { dockerBuildArg: { K: "p", P: "p" } },
    });
    expect(r.merged.dockerBuildArg).toEqual({ K: "p", U: "uw", P: "p" });
  });
});

describe("loadAllLayers", () => {
  /**
   * Parent temp dir. We create an XDG_CONFIG_HOME pointing here so that
   * resolveUserWideDir() resolves to <xdgBase>/ccairgap (= userWideDir).
   */
  let xdgBase: string;
  /** <xdgBase>/ccairgap — the actual user-wide config dir. */
  let userWideDir: string;
  /** Separate temp dir used as HOME so it is distinct from XDG_CONFIG_HOME. */
  let homeDir: string;
  /** Temp root for a minimal git repo acting as the project. */
  let projectDir: string;

  beforeEach(() => {
    xdgBase = mkdtempSync(join(tmpdir(), "ccairgap-xdg-"));
    userWideDir = join(xdgBase, "ccairgap");
    mkdirSync(userWideDir, { recursive: true });
    homeDir = mkdtempSync(join(tmpdir(), "ccairgap-home-"));
    projectDir = mkdtempSync(join(tmpdir(), "ccairgap-proj-"));
    // Initialise a git repo so resolveConfigPath can find the git root.
    execSync("git init", { cwd: projectDir, stdio: "ignore" });
  });

  afterEach(() => {
    rmSync(xdgBase, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  /** Env that steers loadAllLayers to our temp dirs. */
  function env(): Record<string, string> {
    return { XDG_CONFIG_HOME: xdgBase, HOME: homeDir };
  }

  it("bare: true — skips integrations and user-wide config; explicit --config still loads project layer", () => {
    // Set up user-wide config and integration (both should be ignored under --bare).
    mkdirSync(join(userWideDir, "integrations"), { recursive: true });
    writeFileSync(join(userWideDir, "integrations", "a.yaml"), "hooks:\n  enable: ['int-*']\n");
    writeFileSync(join(userWideDir, "config.yaml"), "name: user-wide-name\n");

    // Set up an explicit project config (loaded only because configPath is given).
    const cfgPath = join(projectDir, "explicit.yaml");
    writeFileSync(cfgPath, "name: project-name\n");

    const result = loadAllLayers({
      bare: true,
      userConfigEnabled: true,
      configPath: cfgPath,
      cwd: projectDir,
      env: env(),
    });

    // Project key should appear with "project" provenance.
    expect(result.layered.merged.name).toBe("project-name");
    expect(result.layered.provenance.name).toBe("project");

    // No user-wide or integration provenance anywhere.
    const allProvValues = Object.values(result.layered.provenance).flat();
    for (const v of allProvValues) {
      expect(v).not.toBe("user-wide");
      expect(String(v)).not.toMatch(/^user-wide-integration:/);
    }

    expect(result.projectPath).toBeDefined();
  });

  it("userConfigEnabled: false — skips user-wide layers regardless of bare", () => {
    // Set up user-wide config and integration (both should be ignored).
    mkdirSync(join(userWideDir, "integrations"), { recursive: true });
    writeFileSync(join(userWideDir, "integrations", "a.yaml"), "hooks:\n  enable: ['int-*']\n");
    writeFileSync(join(userWideDir, "config.yaml"), "name: user-wide-name\n");

    // Set up project config.
    mkdirSync(join(projectDir, ".ccairgap"), { recursive: true });
    writeFileSync(join(projectDir, ".ccairgap", "config.yaml"), "name: project-name\n");

    const result = loadAllLayers({
      bare: false,
      userConfigEnabled: false,
      cwd: projectDir,
      env: env(),
    });

    expect(result.layered.merged.name).toBe("project-name");
    expect(result.layered.provenance.name).toBe("project");

    const allProvValues = Object.values(result.layered.provenance).flat();
    for (const v of allProvValues) {
      expect(v).not.toBe("user-wide");
      expect(String(v)).not.toMatch(/^user-wide-integration:/);
    }
  });

  it("full layering — integrations + user-wide + project all contribute with correct provenance", () => {
    // Integration.
    mkdirSync(join(userWideDir, "integrations"), { recursive: true });
    writeFileSync(
      join(userWideDir, "integrations", "switchboard.yaml"),
      "hooks:\n  enable: ['sb-*']\ndocker-run-arg:\n  - '-e SB=1'\n",
    );

    // User-wide config.
    writeFileSync(
      join(userWideDir, "config.yaml"),
      "docker-run-arg:\n  - '-e UW=1'\n",
    );

    // Project config.
    mkdirSync(join(projectDir, ".ccairgap"), { recursive: true });
    writeFileSync(
      join(projectDir, ".ccairgap", "config.yaml"),
      "name: my-project\ndocker-run-arg:\n  - '-e PROJ=1'\n",
    );

    const result = loadAllLayers({
      bare: false,
      userConfigEnabled: true,
      cwd: projectDir,
      env: env(),
    });

    // Scalars: project wins.
    expect(result.layered.merged.name).toBe("my-project");
    expect(result.layered.provenance.name).toBe("project");

    // Arrays: integration → user-wide → project.
    expect(result.layered.merged.dockerRunArg).toEqual(["-e SB=1", "-e UW=1", "-e PROJ=1"]);
    expect(result.layered.provenance.dockerRunArg).toEqual([
      "user-wide-integration:switchboard.yaml",
      "user-wide",
      "project",
    ]);

    // hooks from integration.
    expect(result.layered.merged.hooks?.enable).toEqual(["sb-*"]);
    expect(result.layered.provenance["hooks.enable"]).toEqual(["user-wide-integration:switchboard.yaml"]);

    expect(result.projectPath).toBeDefined();
  });

  it("dotfiles-realpath collision — project layer is skipped when .ccairgap symlinks into user-wide dir", () => {
    // Set up user-wide config.
    writeFileSync(join(userWideDir, "config.yaml"), "name: user-wide-name\n");

    // Make project's .ccairgap a symlink pointing at the user-wide dir so the
    // realpath of .ccairgap/config.yaml lands inside userWideDir.
    symlinkSync(userWideDir, join(projectDir, ".ccairgap"));

    const warnings: string[] = [];
    const errSpy = vi.spyOn(console, "error").mockImplementation((msg: string) => {
      warnings.push(msg);
    });

    let result: ReturnType<typeof loadAllLayers>;
    try {
      result = loadAllLayers({
        bare: false,
        userConfigEnabled: true,
        cwd: projectDir,
        env: env(),
      });
    } finally {
      errSpy.mockRestore();
    }

    // A warning about the collision should have been emitted.
    expect(warnings.some((w) => /loading it once at user-wide layer only/.test(w))).toBe(true);

    // Project layer was skipped — projectPath is undefined.
    expect(result!.projectPath).toBeUndefined();

    // User-wide value is still present from the user-wide layer.
    expect(result!.layered.merged.name).toBe("user-wide-name");
    expect(result!.layered.provenance.name).toBe("user-wide");
  });

  it("profile threading — project layer loads <name>.config.yaml instead of config.yaml", () => {
    // Create both config.yaml (should NOT be loaded) and web.config.yaml (SHOULD be loaded).
    mkdirSync(join(projectDir, ".ccairgap"), { recursive: true });
    writeFileSync(join(projectDir, ".ccairgap", "config.yaml"), "name: default-name\n");
    writeFileSync(join(projectDir, ".ccairgap", "web.config.yaml"), "name: web-name\n");

    const result = loadAllLayers({
      bare: false,
      userConfigEnabled: false,
      profile: "web",
      cwd: projectDir,
      env: env(),
    });

    expect(result.layered.merged.name).toBe("web-name");
    expect(result.layered.provenance.name).toBe("project");
    expect(result.projectPath).toMatch(/web\.config\.yaml$/);
  });
});
