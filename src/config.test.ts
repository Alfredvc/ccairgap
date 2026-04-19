import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execaSync } from "execa";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseConfig,
  resolveConfigPath,
  resolveConfigPaths,
} from "./config.js";

const SRC = "/repo/.ccairgap/config.yaml";

describe("parseConfig", () => {
  it("parses full kebab-case config", () => {
    const yaml = `
repo: /a
extra-repo:
  - /b
ro:
  - /ro1
base: main
keep-container: true
dockerfile: ./Dockerfile
docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"
  FOO: bar
rebuild: false
print: "hello"
name: "my-session"
`;
    expect(parseConfig(yaml, SRC)).toEqual({
      repo: "/a",
      extraRepo: ["/b"],
      ro: ["/ro1"],
      base: "main",
      keepContainer: true,
      dockerfile: "./Dockerfile",
      dockerBuildArg: { CLAUDE_CODE_VERSION: "1.2.3", FOO: "bar" },
      rebuild: false,
      print: "hello",
      name: "my-session",
    });
  });

  it("rejects non-string name", () => {
    expect(() => parseConfig("name: 42\n", SRC)).toThrow(/config\.name: expected string/);
  });

  it("accepts camelCase aliases", () => {
    const yaml = `
keepContainer: true
extraRepo:
  - /e
dockerBuildArg:
  X: "1"
`;
    expect(parseConfig(yaml, SRC)).toEqual({
      keepContainer: true,
      extraRepo: ["/e"],
      dockerBuildArg: { X: "1" },
    });
  });

  it("parses docker-run-arg and warn-docker-args", () => {
    const yaml = `
docker-run-arg:
  - "-p 8080:8080"
  - "--network my-net"
warn-docker-args: false
`;
    expect(parseConfig(yaml, SRC)).toEqual({
      dockerRunArg: ["-p 8080:8080", "--network my-net"],
      warnDockerArgs: false,
    });
  });

  it("rejects non-array docker-run-arg and non-bool warn-docker-args", () => {
    expect(() => parseConfig("docker-run-arg: -p 8080\n", SRC)).toThrow(
      /config\.docker-run-arg: expected array of strings/,
    );
    expect(() => parseConfig('warn-docker-args: "no"\n', SRC)).toThrow(
      /config\.warn-docker-args: expected boolean/,
    );
  });

  it("parses cp / sync / mount as string arrays", () => {
    const yaml = `
cp:
  - node_modules
  - /abs/venv
sync:
  - dist
mount:
  - .cache
`;
    expect(parseConfig(yaml, SRC)).toEqual({
      cp: ["node_modules", "/abs/venv"],
      sync: ["dist"],
      mount: [".cache"],
    });
  });

  it("rejects cp not an array of strings", () => {
    expect(() => parseConfig("cp: node_modules\n", SRC)).toThrow(
      /config\.cp: expected array of strings/,
    );
    expect(() => parseConfig("cp: [1, 2]\n", SRC)).toThrow(/config\.cp: expected string/);
  });

  it("rejects sync / mount wrong types", () => {
    expect(() => parseConfig("sync: dist\n", SRC)).toThrow(
      /config\.sync: expected array of strings/,
    );
    expect(() => parseConfig("mount:\n  - 1\n", SRC)).toThrow(/config\.mount: expected string/);
  });

  it("returns {} for empty / null doc", () => {
    expect(parseConfig("", SRC)).toEqual({});
    expect(parseConfig("# comment only\n", SRC)).toEqual({});
  });

  it("rejects unknown top-level key", () => {
    expect(() => parseConfig("nope: 1\n", SRC)).toThrow(/unknown key 'nope'/);
  });

  it("rejects non-map top level", () => {
    expect(() => parseConfig("- a\n- b\n", SRC)).toThrow(/top-level must be a map/);
  });

  it("rejects repo as array (use extra-repo)", () => {
    expect(() => parseConfig("repo:\n  - /a\n  - /b\n", SRC)).toThrow(
      /config\.repo: expected single string \(workspace\)\. For multiple repos, use 'extra-repo'/,
    );
  });

  it("rejects non-string repo", () => {
    expect(() => parseConfig("repo: 42\n", SRC)).toThrow(/config\.repo: expected string/);
  });

  it("rejects extra-repo that is not array of strings", () => {
    expect(() => parseConfig("extra-repo: /single\n", SRC)).toThrow(
      /config\.extra-repo: expected array of strings/,
    );
    expect(() => parseConfig("extra-repo: [1, 2]\n", SRC)).toThrow(
      /config\.extra-repo: expected string/,
    );
  });

  it("rejects non-boolean flag", () => {
    expect(() => parseConfig('keep-container: "yes"\n', SRC)).toThrow(
      /config\.keep-container: expected boolean/,
    );
  });

  it("rejects non-string print", () => {
    expect(() => parseConfig("print: 42\n", SRC)).toThrow(/config\.print: expected string/);
  });

  it("parses resume as scalar string", () => {
    expect(parseConfig("resume: 01234567-89ab-cdef-0123-456789abcdef\n", SRC)).toEqual({
      resume: "01234567-89ab-cdef-0123-456789abcdef",
    });
  });

  it("rejects non-string resume", () => {
    expect(() => parseConfig("resume: 42\n", SRC)).toThrow(/config\.resume: expected string/);
  });

  it("rejects array resume", () => {
    expect(() => parseConfig("resume:\n  - a\n  - b\n", SRC)).toThrow(/config\.resume: expected string/);
  });

  it("leaves resume untouched in resolveConfigPaths", () => {
    const cfg = { resume: "01234567-89ab-cdef-0123-456789abcdef" };
    expect(resolveConfigPaths(cfg, "/repo/.ccairgap/config.yaml")).toEqual(cfg);
  });

  it("rejects non-string-map docker-build-arg", () => {
    expect(() => parseConfig("docker-build-arg:\n  K: 1\n", SRC)).toThrow(
      /config\.docker-build-arg\.K: expected string value/,
    );
    expect(() => parseConfig("docker-build-arg:\n  - K=V\n", SRC)).toThrow(
      /config\.docker-build-arg: expected map/,
    );
  });

  it("surfaces yaml syntax errors with source", () => {
    expect(() => parseConfig("base: [unclosed\n", SRC)).toThrow(
      new RegExp(`^${SRC.replace(/\//g, "\\/")}: yaml parse error:`),
    );
  });

  it("parses clipboard: false", () => {
    const cfg = parseConfig("clipboard: false\n", "/fake/path.yaml");
    expect(cfg.clipboard).toBe(false);
  });

  it("parses clipboard: true", () => {
    const cfg = parseConfig("clipboard: true\n", "/fake/path.yaml");
    expect(cfg.clipboard).toBe(true);
  });

  it("rejects non-boolean clipboard", () => {
    expect(() => parseConfig("clipboard: yes-please\n", "/fake/path.yaml")).toThrow(/expected boolean/);
  });

  it("accepts no-preserve-dirty (kebab) and noPreserveDirty (camel)", () => {
    const a = parseConfig("no-preserve-dirty: true\n", "test");
    const b = parseConfig("noPreserveDirty: true\n", "test");
    expect(a.noPreserveDirty).toBe(true);
    expect(b.noPreserveDirty).toBe(true);
  });

  it("rejects non-bool no-preserve-dirty", () => {
    expect(() => parseConfig("no-preserve-dirty: yes\n", "test")).toThrow(
      /no-preserve-dirty/,
    );
  });

  it("parses no-auto-memory: true as noAutoMemory = true", () => {
    const cfg = parseConfig("no-auto-memory: true\n", "<test>");
    expect(cfg.noAutoMemory).toBe(true);
  });

  it("parses camelCase noAutoMemory: false", () => {
    const cfg = parseConfig("noAutoMemory: false\n", "<test>");
    expect(cfg.noAutoMemory).toBe(false);
  });

  it("rejects non-boolean noAutoMemory", () => {
    expect(() => parseConfig("no-auto-memory: \"yes\"\n", "<test>")).toThrow(
      /no-auto-memory: expected boolean/,
    );
  });
});

describe("resolveConfigPaths", () => {
  it("resolves repo/extra-repo/ro against git root (parent of .ccairgap/)", () => {
    const cfg = {
      repo: ".",
      extraRepo: ["../sibling", "/abs/path"],
      ro: ["../docs", "~/not-expanded"],
      dockerfile: "Dockerfile",
      base: "main",
    };
    const out = resolveConfigPaths(cfg, "/repo/.ccairgap/config.yaml");
    expect(out).toEqual({
      repo: "/repo",
      extraRepo: ["/sibling", "/abs/path"],
      ro: ["/docs", "/repo/~/not-expanded"],
      dockerfile: "/repo/.ccairgap/Dockerfile",
      base: "main",
    });
  });

  it("dockerfile still anchors on config dir even when workspace anchor differs", () => {
    const cfg = { repo: ".", dockerfile: "./Dockerfile" };
    const out = resolveConfigPaths(cfg, "/repo/.ccairgap/config.yaml");
    expect(out.repo).toBe("/repo");
    expect(out.dockerfile).toBe("/repo/.ccairgap/Dockerfile");
  });

  it("resolves workspace paths against git root for .config/ccairgap/ layout", () => {
    const cfg = {
      repo: ".",
      extraRepo: ["../sibling"],
      ro: ["../docs"],
      dockerfile: "Dockerfile",
    };
    const out = resolveConfigPaths(cfg, "/repo/.config/ccairgap/config.yaml");
    expect(out).toEqual({
      repo: "/repo",
      extraRepo: ["/sibling"],
      ro: ["/docs"],
      dockerfile: "/repo/.config/ccairgap/Dockerfile",
    });
  });

  it("falls back to config dir when config is not in a .ccairgap/ dir", () => {
    const cfg = {
      repo: "./sub",
      extraRepo: ["./more"],
      ro: ["../ro"],
      dockerfile: "./Dockerfile",
    };
    const out = resolveConfigPaths(cfg, "/some/other/my-config.yaml");
    expect(out).toEqual({
      repo: "/some/other/sub",
      extraRepo: ["/some/other/more"],
      ro: ["/some/ro"],
      dockerfile: "/some/other/Dockerfile",
    });
  });

  it("leaves scalars and absent fields untouched", () => {
    const cfg = { base: "main", rebuild: true };
    expect(resolveConfigPaths(cfg, "/repo/.ccairgap/config.yaml")).toEqual(cfg);
  });

  it("does not touch cp / sync / mount (they resolve against repo root later)", () => {
    const cfg = {
      cp: ["node_modules", "./rel", "/abs/x"],
      sync: ["dist"],
      mount: [".cache"],
    };
    expect(resolveConfigPaths(cfg, "/repo/.ccairgap/config.yaml")).toEqual(cfg);
  });

  it("does not treat ccairgap/ as canonical when parent is not .config/", () => {
    const cfg = { repo: "." };
    const out = resolveConfigPaths(cfg, "/some/path/ccairgap/config.yaml");
    expect(out.repo).toBe("/some/path/ccairgap"); // configDir, not git root
  });
});

describe("resolveConfigPath", () => {
  let root: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-cfg-")));
    execaSync("git", ["init", "-q"], { cwd: root });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writePrimary(): string {
    const dir = join(root, ".ccairgap");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "config.yaml");
    writeFileSync(p, "");
    return p;
  }

  function writeAlternate(): string {
    const dir = join(root, ".config", "ccairgap");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "config.yaml");
    writeFileSync(p, "");
    return p;
  }

  it("returns .ccairgap/config.yaml when only that exists", () => {
    const primary = writePrimary();
    expect(resolveConfigPath(undefined, root)).toBe(primary);
  });

  it("returns .config/ccairgap/config.yaml when only that exists", () => {
    const alternate = writeAlternate();
    expect(resolveConfigPath(undefined, root)).toBe(alternate);
  });

  it("returns .ccairgap/config.yaml and warns when both exist", () => {
    const primary = writePrimary();
    writeAlternate();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(resolveConfigPath(undefined, root)).toBe(primary);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]?.[0];
    expect(msg).toMatch(/both \.ccairgap\/config\.yaml and \.config\/ccairgap\/config\.yaml/);
    expect(msg).toMatch(/using \.ccairgap\/config\.yaml/);
  });

  it("returns undefined when neither exists", () => {
    expect(resolveConfigPath(undefined, root)).toBeUndefined();
  });

  it("does not emit the collision warning when --config is passed explicitly", () => {
    const primary = writePrimary();
    writeAlternate();
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    // Explicit --config pointing at the primary: loader must skip the walk
    // (and thus skip the collision warning).
    expect(resolveConfigPath(primary, root)).toBe(primary);
    expect(warn).not.toHaveBeenCalled();
  });

  describe("profile", () => {
    function writeProfilePrimary(name: string): string {
      const dir = join(root, ".ccairgap");
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${name}.config.yaml`);
      writeFileSync(p, "");
      return p;
    }

    function writeProfileAlternate(name: string): string {
      const dir = join(root, ".config", "ccairgap");
      mkdirSync(dir, { recursive: true });
      const p = join(dir, `${name}.config.yaml`);
      writeFileSync(p, "");
      return p;
    }

    it("resolves --profile <name> to .ccairgap/<name>.config.yaml", () => {
      const p = writeProfilePrimary("web");
      expect(resolveConfigPath(undefined, root, "web")).toBe(p);
    });

    it("falls back to .config/ccairgap/<name>.config.yaml", () => {
      const p = writeProfileAlternate("web");
      expect(resolveConfigPath(undefined, root, "web")).toBe(p);
    });

    it("--profile default is identical to no profile (uses config.yaml)", () => {
      const primary = writePrimary();
      expect(resolveConfigPath(undefined, root, "default")).toBe(primary);
    });

    it("--profile default still returns undefined when no config exists", () => {
      expect(resolveConfigPath(undefined, root, "default")).toBeUndefined();
    });

    it("errors when profile file is missing (no silent fallback)", () => {
      expect(() => resolveConfigPath(undefined, root, "web")).toThrow(
        /--profile web: config file not found/,
      );
    });

    it("errors when not inside a git repo", () => {
      const outside = realpathSync(mkdtempSync(join(tmpdir(), "airgap-nogit-")));
      try {
        expect(() => resolveConfigPath(undefined, outside, "web")).toThrow(
          /--profile web: not inside a git repo/,
        );
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });

    it("warns when both profile locations exist and picks primary", () => {
      const primary = writeProfilePrimary("web");
      writeProfileAlternate("web");
      const warn = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(resolveConfigPath(undefined, root, "web")).toBe(primary);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/web\.config\.yaml/);
    });

    it("rejects invalid profile names", () => {
      expect(() => resolveConfigPath(undefined, root, "web/prod")).toThrow(
        /--profile: invalid name 'web\/prod'/,
      );
      expect(() => resolveConfigPath(undefined, root, "")).toThrow(
        /--profile: invalid name/,
      );
      expect(() => resolveConfigPath(undefined, root, "../etc/passwd")).toThrow(
        /--profile: invalid name/,
      );
    });

    it("accepts alnum + . _ - in profile names", () => {
      const p = writeProfilePrimary("web.prod_v2-alpha");
      expect(resolveConfigPath(undefined, root, "web.prod_v2-alpha")).toBe(p);
    });
  });
});
