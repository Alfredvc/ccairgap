import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realpathSync } from "node:fs";
import { resolveArtifacts, type RepoForArtifacts } from "./artifacts.js";

let root: string;
let repoPath: string;
let sessionDir: string;
let repos: RepoForArtifacts[];

beforeEach(() => {
  // realpath to dodge macOS /var → /private/var symlink divergence.
  root = realpathSync(mkdtempSync(join(tmpdir(), "airlock-art-")));
  repoPath = join(root, "repo");
  sessionDir = join(root, "session");
  mkdirSync(repoPath, { recursive: true });
  mkdirSync(sessionDir, { recursive: true });

  // seed some fs entries used across tests
  mkdirSync(join(repoPath, "node_modules"), { recursive: true });
  mkdirSync(join(repoPath, ".venv"), { recursive: true });
  writeFileSync(join(repoPath, "one_file.txt"), "x");
  mkdirSync(join(root, "outside"), { recursive: true });

  repos = [
    { basename: "repo", hostPath: repoPath, sessionClonePath: join(sessionDir, "repos", "repo") },
  ];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveArtifacts", () => {
  it("relative cp resolves against workspace repo; sessionSrc is inside clone", () => {
    const r = resolveArtifacts({
      cp: ["node_modules"],
      sync: [],
      mount: [],
      repos,
      roPaths: [],
      sessionDir,
    });
    expect(r.entries).toHaveLength(1);
    const e = r.entries[0]!;
    expect(e.kind).toBe("cp");
    expect(e.srcHost).toBe(join(repoPath, "node_modules"));
    expect(e.insideRepoClone).toBe(true);
    expect(e.sessionSrc).toBe(join(sessionDir, "repos", "repo", "node_modules"));
    expect(r.extraMounts).toEqual([]); // in-repo cp rides on repo mount
    expect(r.warnings).toEqual([]);
  });

  it("absolute cp outside all repos lands under $SESSION/artifacts and adds a bind mount", () => {
    const outside = join(root, "outside");
    const r = resolveArtifacts({
      cp: [outside],
      sync: [],
      mount: [],
      repos,
      roPaths: [],
      sessionDir,
    });
    const e = r.entries[0]!;
    expect(e.insideRepoClone).toBe(false);
    // $SESSION/artifacts/<abs-src-stripped-of-leading-slash>
    expect(e.sessionSrc).toBe(join(sessionDir, "artifacts", outside.replace(/^\//, "")));
    expect(r.extraMounts).toEqual([
      { src: e.sessionSrc!, dst: outside, mode: "rw" },
    ]);
    expect(r.warnings.some((w) => w.includes("outside all"))).toBe(true);
  });

  it("relative path without any repo throws", () => {
    expect(() =>
      resolveArtifacts({
        cp: ["node_modules"],
        sync: [],
        mount: [],
        repos: [],
        roPaths: [],
        sessionDir,
      }),
    ).toThrow(/requires --repo/);
  });

  it("missing host path throws", () => {
    expect(() =>
      resolveArtifacts({
        cp: ["does_not_exist"],
        sync: [],
        mount: [],
        repos,
        roPaths: [],
        sessionDir,
      }),
    ).toThrow(/host path does not exist/);
  });

  it("overlap: --cp X and --ro X → throws", () => {
    expect(() =>
      resolveArtifacts({
        cp: ["node_modules"],
        sync: [],
        mount: [],
        repos,
        roPaths: [join(repoPath, "node_modules")],
        sessionDir,
      }),
    ).toThrow(/used by both/);
  });

  it("overlap: --sync X and --mount X → throws", () => {
    expect(() =>
      resolveArtifacts({
        cp: [],
        sync: ["node_modules"],
        mount: ["node_modules"],
        repos,
        roPaths: [],
        sessionDir,
      }),
    ).toThrow(/used by both/);
  });

  it("overlap: same path listed twice in --cp → throws", () => {
    expect(() =>
      resolveArtifacts({
        cp: ["node_modules", "node_modules"],
        sync: [],
        mount: [],
        repos,
        roPaths: [],
        sessionDir,
      }),
    ).toThrow(/used by both/);
  });

  it("overlap: path equals --repo root → throws", () => {
    expect(() =>
      resolveArtifacts({
        cp: [repoPath],
        sync: [],
        mount: [],
        repos,
        roPaths: [],
        sessionDir,
      }),
    ).toThrow(/used by both/);
  });

  it("--mount always produces a RW extraMount and no sessionSrc", () => {
    const r = resolveArtifacts({
      cp: [],
      sync: [],
      mount: ["node_modules"],
      repos,
      roPaths: [],
      sessionDir,
    });
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]!.sessionSrc).toBeUndefined();
    expect(r.extraMounts).toEqual([
      { src: join(repoPath, "node_modules"), dst: join(repoPath, "node_modules"), mode: "rw" },
    ]);
  });

  it("--sync records manifest entry for handoff copy-out", () => {
    const r = resolveArtifacts({
      cp: [],
      sync: ["node_modules"],
      mount: [],
      repos,
      roPaths: [],
      sessionDir,
    });
    expect(r.syncRecords).toEqual([
      {
        src_host: join(repoPath, "node_modules"),
        session_src: join(sessionDir, "repos", "repo", "node_modules"),
      },
    ]);
  });

  it("file (not dir) cp is accepted", () => {
    const r = resolveArtifacts({
      cp: ["one_file.txt"],
      sync: [],
      mount: [],
      repos,
      roPaths: [],
      sessionDir,
    });
    expect(r.entries[0]!.srcHost).toBe(join(repoPath, "one_file.txt"));
  });
});
