import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execaSync } from "execa";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCmd, resolveInitTarget } from "./subcommands.js";
import { defaultDockerfile, defaultEntrypoint } from "./image.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-init-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function initGitRepo(dir: string): void {
  execaSync("git", ["init", "-q"], { cwd: dir });
}

describe("resolveInitTarget", () => {
  it("uses <git-root>/.ccairgap when no --config is passed", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    initGitRepo(repo);
    expect(resolveInitTarget({ cwd: repo, force: false })).toBe(
      join(repo, ".ccairgap"),
    );
  });

  it("follows dirname(--config) when --config is passed", () => {
    const cfgDir = join(root, "some", "where");
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, "cfg.yaml");
    expect(
      resolveInitTarget({ cwd: root, force: false, configPath: cfgPath }),
    ).toBe(cfgDir);
  });

  it("resolves relative --config against cwd", () => {
    const cfgDir = join(root, "nested");
    mkdirSync(cfgDir);
    expect(
      resolveInitTarget({ cwd: root, force: false, configPath: "nested/cfg.yaml" }),
    ).toBe(cfgDir);
  });

  it("errors when not in a git repo and no --config passed", () => {
    expect(() => resolveInitTarget({ cwd: root, force: false })).toThrow(
      /not in a git repo/,
    );
  });

  it("targets .config/ccairgap/ when it exists and .ccairgap/ does not", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    initGitRepo(repo);
    mkdirSync(join(repo, ".config", "ccairgap"), { recursive: true });
    expect(resolveInitTarget({ cwd: repo, force: false })).toBe(
      join(repo, ".config", "ccairgap"),
    );
  });

  it("still targets .ccairgap/ when both canonical dirs exist", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    initGitRepo(repo);
    mkdirSync(join(repo, ".ccairgap"));
    mkdirSync(join(repo, ".config", "ccairgap"), { recursive: true });
    expect(resolveInitTarget({ cwd: repo, force: false })).toBe(
      join(repo, ".ccairgap"),
    );
  });

  it("targets .ccairgap/ when neither canonical dir exists", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    initGitRepo(repo);
    expect(resolveInitTarget({ cwd: repo, force: false })).toBe(
      join(repo, ".ccairgap"),
    );
  });
});

describe("initCmd", () => {
  it("writes Dockerfile, entrypoint.sh, and config.yaml into target dir", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    initGitRepo(repo);

    initCmd({ cwd: repo, force: false });

    const target = join(repo, ".ccairgap");
    expect(readFileSync(join(target, "Dockerfile"), "utf8")).toBe(
      readFileSync(defaultDockerfile(), "utf8"),
    );
    expect(readFileSync(join(target, "entrypoint.sh"), "utf8")).toBe(
      readFileSync(defaultEntrypoint(), "utf8"),
    );
    expect(readFileSync(join(target, "config.yaml"), "utf8")).toContain(
      "dockerfile: Dockerfile",
    );
  });

  it("refuses to overwrite existing files without --force", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    initGitRepo(repo);
    const target = join(repo, ".ccairgap");
    mkdirSync(target);
    writeFileSync(join(target, "Dockerfile"), "USER edited\n");

    expect(() => initCmd({ cwd: repo, force: false })).toThrow(
      /refusing to overwrite/,
    );
    // Existing file must survive the failed attempt.
    expect(readFileSync(join(target, "Dockerfile"), "utf8")).toBe("USER edited\n");
  });

  it("--force overwrites all three files unconditionally", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    initGitRepo(repo);
    const target = join(repo, ".ccairgap");
    mkdirSync(target);
    writeFileSync(join(target, "Dockerfile"), "USER edited\n");
    writeFileSync(join(target, "entrypoint.sh"), "#!/bin/sh\necho user\n");
    writeFileSync(join(target, "config.yaml"), "repo: ../foo\n");

    initCmd({ cwd: repo, force: true });

    expect(readFileSync(join(target, "Dockerfile"), "utf8")).toBe(
      readFileSync(defaultDockerfile(), "utf8"),
    );
    expect(readFileSync(join(target, "entrypoint.sh"), "utf8")).toBe(
      readFileSync(defaultEntrypoint(), "utf8"),
    );
    // config.yaml is fully rewritten — prior keys are gone.
    const cfg = readFileSync(join(target, "config.yaml"), "utf8");
    expect(cfg).toContain("dockerfile: Dockerfile");
    expect(cfg).not.toContain("../foo");
  });

  it("creates the target dir if it does not yet exist", () => {
    const repo = join(root, "repo");
    mkdirSync(repo);
    initGitRepo(repo);
    const target = join(repo, ".ccairgap");
    expect(existsSync(target)).toBe(false);

    initCmd({ cwd: repo, force: false });
    expect(existsSync(target)).toBe(true);
  });
});

describe("initCmd --user", () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "uw-init-")); });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it("creates ~/.config/ccairgap/ with config.yaml + integrations/", () => {
    initCmd({ user: true, force: false, env: { HOME: home } });
    const dir = join(home, ".config", "ccairgap");
    expect(existsSync(join(dir, "config.yaml"))).toBe(true);
    expect(statSync(join(dir, "integrations")).isDirectory()).toBe(true);
  });

  it("--user without --force refuses to overwrite existing config.yaml", () => {
    const dir = join(home, ".config", "ccairgap");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "existing\n");
    expect(() =>
      initCmd({ user: true, force: false, env: { HOME: home } }),
    ).toThrow(/refusing to overwrite/);
  });

  it("--user --force overwrites", () => {
    const dir = join(home, ".config", "ccairgap");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "existing\n");
    initCmd({ user: true, force: true, env: { HOME: home } });
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).not.toBe("existing\n");
  });
});
