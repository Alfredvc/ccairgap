import { describe, expect, it } from "vitest";
import { parseConfig, resolveConfigPaths } from "./config.js";

const SRC = "/repo/.claude-airgap/config.yaml";

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
    });
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
});

describe("resolveConfigPaths", () => {
  it("resolves relative repo/extra-repo/ro/dockerfile against config dir", () => {
    const cfg = {
      repo: "./sub",
      extraRepo: ["./more", "/abs/path"],
      ro: ["../ro"],
      dockerfile: "./Dockerfile",
      base: "main",
    };
    const out = resolveConfigPaths(cfg, "/repo/.claude-airgap/config.yaml");
    expect(out).toEqual({
      repo: "/repo/.claude-airgap/sub",
      extraRepo: ["/repo/.claude-airgap/more", "/abs/path"],
      ro: ["/repo/ro"],
      dockerfile: "/repo/.claude-airgap/Dockerfile",
      base: "main",
    });
  });

  it("leaves scalars and absent fields untouched", () => {
    const cfg = { base: "main", rebuild: true };
    expect(resolveConfigPaths(cfg, "/repo/.claude-airgap/config.yaml")).toEqual(cfg);
  });

  it("does not touch cp / sync / mount (they resolve against repo root later)", () => {
    const cfg = {
      cp: ["node_modules", "./rel", "/abs/x"],
      sync: ["dist"],
      mount: [".cache"],
    };
    expect(resolveConfigPaths(cfg, "/repo/.claude-airgap/config.yaml")).toEqual(cfg);
  });
});
