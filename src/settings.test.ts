import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enumerateEnv, enumerateMarketplaces } from "./settings.js";

describe("enumerateEnv", () => {
  let root: string;
  let hostClaude: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "settings-enum-"));
    hostClaude = join(root, "host-claude");
    mkdirSync(hostClaude, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeJSON(path: string, data: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  }

  it("emits records from user, project, and project-local scopes with attribution", () => {
    const repoDir = join(root, "src", "myrepo");
    mkdirSync(repoDir, { recursive: true });

    writeJSON(join(hostClaude, "settings.json"), {
      env: { USER_VAR: "user-val", SHARED: "user-wins" },
    });
    writeJSON(join(repoDir, ".claude", "settings.json"), {
      env: { PROJECT_VAR: "proj-val" },
    });
    writeJSON(join(repoDir, ".claude", "settings.local.json"), {
      env: { LOCAL_VAR: "local-val" },
    });

    const records = enumerateEnv({
      hostClaudeDir: hostClaude,
      repos: [{ basename: "myrepo", hostPath: repoDir }],
    });

    const byKey = records.map((r) => ({ source: r.source, name: r.name, repo: r.repo }));
    expect(byKey).toEqual([
      { source: "user", name: "USER_VAR", repo: undefined },
      { source: "user", name: "SHARED", repo: undefined },
      { source: "project", name: "PROJECT_VAR", repo: "myrepo" },
      { source: "project", name: "LOCAL_VAR", repo: "myrepo" },
    ]);
    expect(records.find((r) => r.name === "PROJECT_VAR")!.sourcePath).toBe(
      join(repoDir, ".claude", "settings.json"),
    );
    expect(records.find((r) => r.name === "LOCAL_VAR")!.sourcePath).toBe(
      join(repoDir, ".claude", "settings.local.json"),
    );
  });

  it("skips non-string values and malformed env shapes", () => {
    writeJSON(join(hostClaude, "settings.json"), {
      env: {
        OK: "yes",
        BROKEN_NUM: 42,
        BROKEN_OBJ: { nested: "bad" },
        BROKEN_NULL: null,
      },
    });

    const records = enumerateEnv({ hostClaudeDir: hostClaude, repos: [] });
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toBe("OK");
    expect(records[0]!.value).toBe("yes");
  });

  it("returns empty when no settings files exist", () => {
    const records = enumerateEnv({ hostClaudeDir: hostClaude, repos: [] });
    expect(records).toEqual([]);
  });

  it("tolerates malformed JSON and missing env key", () => {
    writeFileSync(join(hostClaude, "settings.json"), "{ not valid");
    const records = enumerateEnv({ hostClaudeDir: hostClaude, repos: [] });
    expect(records).toEqual([]);
  });

  it("ignores env when it is not an object", () => {
    writeJSON(join(hostClaude, "settings.json"), { env: "not-an-object" });
    const records = enumerateEnv({ hostClaudeDir: hostClaude, repos: [] });
    expect(records).toEqual([]);
  });
});

describe("enumerateMarketplaces", () => {
  let root: string;
  let hostClaude: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "mkt-enum-"));
    hostClaude = join(root, "host-claude");
    mkdirSync(hostClaude, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeJSON(path: string, data: unknown): void {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(data));
  }

  it("emits entries for each source type with sourceType + hostPath shortcuts", () => {
    const dirPath = join(root, "some-dir-market");
    const filePath = join(root, "some-market.json");
    writeJSON(join(hostClaude, "settings.json"), {
      extraKnownMarketplaces: {
        "gh-one": { source: { source: "github", repo: "owner/name" } },
        "dir-one": { source: { source: "directory", path: dirPath } },
        "file-one": { source: { source: "file", path: filePath } },
        "git-one": { source: { source: "git", url: "https://example/a.git" } },
        "inline-one": { source: { source: "settings" }, plugins: [] },
      },
    });

    const records = enumerateMarketplaces({ hostClaudeDir: hostClaude, repos: [] });
    const byName = Object.fromEntries(records.map((r) => [r.name, r]));

    expect(byName["gh-one"]!.sourceType).toBe("github");
    expect(byName["gh-one"]!.hostPath).toBeUndefined();

    expect(byName["dir-one"]!.sourceType).toBe("directory");
    expect(byName["dir-one"]!.hostPath).toBe(dirPath);

    expect(byName["file-one"]!.sourceType).toBe("file");
    expect(byName["file-one"]!.hostPath).toBe(filePath);

    expect(byName["git-one"]!.sourceType).toBe("git");
    expect(byName["git-one"]!.hostPath).toBeUndefined();

    expect(byName["inline-one"]!.sourceType).toBe("settings");
    expect(byName["inline-one"]!.hostPath).toBeUndefined();
    expect(byName["inline-one"]!.entry.plugins).toEqual([]);
  });

  it("walks project + project-local scopes with repo attribution", () => {
    const repoDir = join(root, "src", "myrepo");
    mkdirSync(repoDir, { recursive: true });
    writeJSON(join(repoDir, ".claude", "settings.json"), {
      extraKnownMarketplaces: { "proj-market": { source: { source: "github" } } },
    });
    writeJSON(join(repoDir, ".claude", "settings.local.json"), {
      extraKnownMarketplaces: { "local-market": { source: { source: "github" } } },
    });

    const records = enumerateMarketplaces({
      hostClaudeDir: hostClaude,
      repos: [{ basename: "myrepo", hostPath: repoDir }],
    });

    expect(records.map((r) => ({ name: r.name, source: r.source, repo: r.repo }))).toEqual([
      { name: "proj-market", source: "project", repo: "myrepo" },
      { name: "local-market", source: "project", repo: "myrepo" },
    ]);
  });

  it("tolerates malformed entries and missing fields", () => {
    writeJSON(join(hostClaude, "settings.json"), {
      extraKnownMarketplaces: {
        "bad-arr": [],
        "bad-null": null,
        "no-source": { plugins: [] },
        "bad-source-shape": { source: "not-an-object" },
        "ok": { source: { source: "github" } },
      },
    });

    const records = enumerateMarketplaces({ hostClaudeDir: hostClaude, repos: [] });
    expect(records.map((r) => r.name)).toEqual(["no-source", "bad-source-shape", "ok"]);
    expect(records.find((r) => r.name === "no-source")!.sourceType).toBeUndefined();
    expect(records.find((r) => r.name === "bad-source-shape")!.sourceType).toBeUndefined();
    expect(records.find((r) => r.name === "ok")!.sourceType).toBe("github");
  });

  it("returns empty when settings file missing or extraKnownMarketplaces absent", () => {
    expect(enumerateMarketplaces({ hostClaudeDir: hostClaude, repos: [] })).toEqual([]);
    writeJSON(join(hostClaude, "settings.json"), { other: "fields" });
    expect(enumerateMarketplaces({ hostClaudeDir: hostClaude, repos: [] })).toEqual([]);
  });

  it("ignores hostPath shortcut when path is missing on directory/file source", () => {
    writeJSON(join(hostClaude, "settings.json"), {
      extraKnownMarketplaces: {
        "dir-no-path": { source: { source: "directory" } },
      },
    });
    const records = enumerateMarketplaces({ hostClaudeDir: hostClaude, repos: [] });
    expect(records[0]!.sourceType).toBe("directory");
    expect(records[0]!.hostPath).toBeUndefined();
  });
});
