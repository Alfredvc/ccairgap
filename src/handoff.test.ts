import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execaSync } from "execa";
import { handoff } from "./handoff.js";
import { writeManifest, type Manifest } from "./manifest.js";

let root: string;

function git(args: string[], cwd: string): void {
  execaSync("git", args, { cwd, stdio: "pipe" });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(["init", "-q", "-b", "main"], dir);
  git(["config", "user.email", "t@t"], dir);
  git(["config", "user.name", "t"], dir);
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], dir);
  git(["commit", "-qm", "seed"], dir);
}

/** Initialize a fake host repo that the session clone points at. */
function initHostRepo(dir: string): void {
  initRepo(dir);
}

/** Clone the host repo into $SESSION/repos/<altName>/, check out the sandbox branch. Returns clone path. */
function seedSession(opts: {
  sessionDir: string;
  hostRepo: string;
  altName: string;
  branch: string;
}): string {
  const { sessionDir, hostRepo, altName, branch } = opts;
  mkdirSync(join(sessionDir, "repos"), { recursive: true });
  mkdirSync(join(sessionDir, "transcripts"), { recursive: true });
  const clone = join(sessionDir, "repos", altName);
  execaSync("git", ["clone", "--shared", "-q", hostRepo, clone], { stdio: "pipe" });
  execaSync("git", ["-C", clone, "config", "user.email", "t@t"], { stdio: "pipe" });
  execaSync("git", ["-C", clone, "config", "user.name", "t"], { stdio: "pipe" });
  execaSync("git", ["-C", clone, "checkout", "-q", "-b", branch], { stdio: "pipe" });
  return clone;
}

/** Write a minimal v1 manifest pointing at one host repo. */
function writeMin(opts: {
  sessionDir: string;
  hostPath: string;
  basename: string;
  altName: string;
  branch: string;
}): void {
  const m: Manifest = {
    version: 1,
    cli_version: "test",
    image_tag: "test:1",
    created_at: new Date().toISOString(),
    repos: [
      {
        basename: opts.basename,
        host_path: opts.hostPath,
        alternates_name: opts.altName,
      },
    ],
    branch: opts.branch,
    claude_code: {},
  };
  writeManifest(opts.sessionDir, m);
}

/** Multi-repo variant of writeMin — used by the multi-repo test in Step 10. */
function writeMinMulti(opts: {
  sessionDir: string;
  repos: Array<{ hostPath: string; basename: string; altName: string }>;
  branch: string;
}): void {
  const m: Manifest = {
    version: 1,
    cli_version: "test",
    image_tag: "test:1",
    created_at: new Date().toISOString(),
    repos: opts.repos.map((r) => ({
      basename: r.basename,
      host_path: r.hostPath,
      alternates_name: r.altName,
    })),
    branch: opts.branch,
    claude_code: {},
  };
  writeManifest(opts.sessionDir, m);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-handoff-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("handoff — dirty tree preservation", () => {
  let sessionDir: string;
  let hostRepo: string;
  const id = "test-a1b2";
  const branch = `ccairgap/${id}`;
  const altName = "hostrepo-00000000";

  beforeEach(() => {
    hostRepo = join(root, "hostrepo");
    initHostRepo(hostRepo);
    sessionDir = join(root, "sessions", id);
    mkdirSync(sessionDir, { recursive: true });
    writeMin({
      sessionDir,
      hostPath: hostRepo,
      basename: "hostrepo",
      altName,
      branch,
    });
  });

  it("preserves the session dir when the session clone has modified files", async () => {
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    writeFileSync(join(sc, "seed.txt"), "edited\n");

    const r = await handoff(sessionDir, "test", () => {});

    expect(r.preserved).toBe(true);
    expect(r.removed).toBe(false);
    expect(existsSync(sessionDir)).toBe(true);
    expect(r.warnings.join("\n")).toContain("uncommitted changes");
    expect(r.warnings.join("\n")).toContain(hostRepo);
    expect(r.warnings.join("\n")).toContain("1 tracked-file change");
  });

  it("regression: clean tree + empty sandbox → session removed", async () => {
    seedSession({ sessionDir, hostRepo, altName, branch });

    const r = await handoff(sessionDir, "test", () => {});

    expect(r.preserved).toBe(false);
    expect(r.removed).toBe(true);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("regression: clean tree + sandbox commits → fetched and removed", async () => {
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    writeFileSync(join(sc, "new-in-branch.txt"), "work\n");
    git(["add", "new-in-branch.txt"], sc);
    git(["commit", "-qm", "work"], sc);

    const r = await handoff(sessionDir, "test", () => {});

    expect(r.preserved).toBe(false);
    expect(r.removed).toBe(true);
    expect(r.fetched[0]!.status).toBe("fetched");
    // Host repo now has the sandbox branch.
    const refs = execaSync("git", [
      "-C",
      hostRepo,
      "for-each-ref",
      "--format=%(refname:short)",
    ]).stdout;
    expect(refs.split("\n")).toContain(branch);
  });

  it("dirty tree + sandbox commits → commits fetched AND session preserved", async () => {
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    writeFileSync(join(sc, "new-in-branch.txt"), "work\n");
    git(["add", "new-in-branch.txt"], sc);
    git(["commit", "-qm", "work"], sc);
    writeFileSync(join(sc, "seed.txt"), "edited after commit\n");

    const r = await handoff(sessionDir, "test", () => {});

    expect(r.preserved).toBe(true);
    expect(r.removed).toBe(false);
    expect(r.fetched[0]!.status).toBe("fetched");
    expect(existsSync(sessionDir)).toBe(true);
  });

  it("untracked (non-ignored) files preserve", async () => {
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    writeFileSync(join(sc, "newfile.txt"), "x\n");

    const r = await handoff(sessionDir, "test", () => {});

    expect(r.preserved).toBe(true);
    expect(r.warnings.join("\n")).toContain("1 untracked entry");
  });

  it("only-ignored files → session removed (regression for noisy .gitignore)", async () => {
    // Add .gitignore to the HOST repo BEFORE branching — so the session
    // clone inherits it on `git clone --shared` and the sandbox branch has
    // 0 commits (no fetch, no preservation trigger from committed work).
    writeFileSync(join(hostRepo, ".gitignore"), "junk/\n");
    git(["add", ".gitignore"], hostRepo);
    git(["commit", "-qm", "ignore"], hostRepo);
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    mkdirSync(join(sc, "junk"));
    writeFileSync(join(sc, "junk", "artifact.log"), "log\n");

    const r = await handoff(sessionDir, "test", () => {});

    // Working tree is clean (ignored files don't surface in porcelain),
    // sandbox branch is empty, no orphan → session removed.
    expect(r.preserved).toBe(false);
    expect(r.removed).toBe(true);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("scan-failed (.git removed) → preserved with scan-failed warning", async () => {
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    rmSync(join(sc, ".git"), { recursive: true, force: true });

    const r = await handoff(sessionDir, "test", () => {});

    expect(r.preserved).toBe(true);
    expect(r.warnings.join("\n")).toContain("could not scan session clone");
    expect(r.warnings.join("\n")).toContain(`discard ${id}`);
  });

  it("combined (dirty + orphan branch) → preserved, warning omits discard hint", async () => {
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    // Orphan branch: create a side branch with a commit, then switch back to
    // the sandbox branch (leaving the sandbox branch itself with 0 commits).
    git(["checkout", "-q", "-b", "side"], sc);
    writeFileSync(join(sc, "side.txt"), "side work\n");
    git(["add", "side.txt"], sc);
    git(["commit", "-qm", "side work"], sc);
    git(["checkout", "-q", branch], sc);
    // Plus dirty tree on the sandbox branch.
    writeFileSync(join(sc, "seed.txt"), "wip\n");

    const r = await handoff(sessionDir, "test", () => {});
    const joined = r.warnings.join("\n");

    expect(r.preserved).toBe(true);
    expect(joined).toContain("uncommitted changes");
    expect(joined).toContain("`side`");
    expect(joined).toContain("BOTH uncommitted work AND committed work");
    // Discard hint is suppressed in the combined shape.
    expect(joined).not.toContain("To drop the work: ccairgap discard");
  });

  it("noPreserveDirty: true skips the dirty check → session removed", async () => {
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    writeFileSync(join(sc, "seed.txt"), "edited\n");

    const r = await handoff(sessionDir, "test", () => {}, { noPreserveDirty: true });

    expect(r.preserved).toBe(false);
    expect(r.removed).toBe(true);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("noPreserveDirty: true still preserves on orphan branch", async () => {
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    git(["checkout", "-q", "-b", "side"], sc);
    writeFileSync(join(sc, "side.txt"), "side\n");
    git(["add", "side.txt"], sc);
    git(["commit", "-qm", "side"], sc);
    git(["checkout", "-q", branch], sc);

    const r = await handoff(sessionDir, "test", () => {}, { noPreserveDirty: true });

    expect(r.preserved).toBe(true);
    expect(r.removed).toBe(false);
  });

  it("noPreserveDirty: true still preserves on scan failure", async () => {
    const sc = seedSession({ sessionDir, hostRepo, altName, branch });
    rmSync(join(sc, ".git"), { recursive: true, force: true });

    const r = await handoff(sessionDir, "test", () => {}, { noPreserveDirty: true });

    expect(r.preserved).toBe(true);
    expect(r.warnings.join("\n")).toContain("could not scan session clone");
  });

  it("logs one line per main session id and skips sidecar dirs", async () => {
    // Override HOME so the cp -r lands inside the test sandbox instead of
    // the developer's real ~/.claude/projects/.
    const fakeHome = join(root, "fakehome");
    mkdirSync(fakeHome, { recursive: true });
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      seedSession({ sessionDir, hostRepo, altName, branch });
      const encoded = "-Users-test-project-foo";
      const td = join(sessionDir, "transcripts", encoded);
      mkdirSync(td, { recursive: true });
      writeFileSync(join(td, "alpha.jsonl"), "{}\n");
      writeFileSync(join(td, "beta.jsonl"), "{}\n");
      // Sidecar dir Claude Code drops next to the main jsonl for subagent
      // transcripts. Must be copied but must NOT produce its own log line.
      mkdirSync(join(td, "alpha", "subagents"), { recursive: true });
      writeFileSync(join(td, "alpha", "subagents", "agent-x.jsonl"), "{}\n");

      const logs: string[] = [];
      const r = await handoff(sessionDir, "test", (m) => logs.push(m));

      expect(r.transcriptsCopied).toBe(1);
      expect(r.transcriptFiles.sort()).toEqual([
        join(encoded, "alpha.jsonl"),
        join(encoded, "beta.jsonl"),
      ]);
      const sessionLines = logs.filter((l) => l.includes("session copied:"));
      expect(sessionLines.sort()).toEqual([
        "[handoff] session copied: alpha",
        "[handoff] session copied: beta",
      ]);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it("multi-repo: one dirty → whole session preserved, warning names the dirty repo", async () => {
    const hostA = join(root, "repo-a");
    const hostB = join(root, "repo-b");
    initHostRepo(hostA);
    initHostRepo(hostB);
    const id2 = "multi-x1y2";
    const branch2 = `ccairgap/${id2}`;
    const sd2 = join(root, "sessions", id2);
    mkdirSync(sd2, { recursive: true });
    const altA = "repo-a-aaaaaaaa";
    const altB = "repo-b-bbbbbbbb";
    writeMinMulti({
      sessionDir: sd2,
      repos: [
        { hostPath: hostA, basename: "repo-a", altName: altA },
        { hostPath: hostB, basename: "repo-b", altName: altB },
      ],
      branch: branch2,
    });
    seedSession({
      sessionDir: sd2,
      hostRepo: hostA,
      altName: altA,
      branch: branch2,
    });
    const cloneB = seedSession({
      sessionDir: sd2,
      hostRepo: hostB,
      altName: altB,
      branch: branch2,
    });
    writeFileSync(join(cloneB, "seed.txt"), "edited-in-B\n");

    const r = await handoff(sd2, "test", () => {});
    const joined = r.warnings.join("\n");

    expect(r.preserved).toBe(true);
    expect(existsSync(sd2)).toBe(true);
    expect(joined).toContain(hostB);
    // Use .not.toContain (string match) rather than a RegExp built from a
    // tmpdir path, which can contain regex-special chars on some systems.
    expect(joined).not.toContain(`${hostA}: uncommitted`);
  });
});

describe("handoff — Codex rollout copy-out", () => {
  function codexManifest(sessionDir: string, hostHome: string): Manifest {
    return {
      version: 1,
      agent: "codex",
      cli_version: "test",
      image_tag: "test:1",
      created_at: new Date().toISOString(),
      repos: [],
      branch: "ccairgap/codex-0001",
      codex: { host_home: hostHome },
      claude_code: {},
    };
  }

  function writeCodexRollout(sessionDir: string, content = "{\"type\":\"session\"}\n"): string {
    const file = join(
      sessionDir,
      "codex-sessions",
      "2026",
      "05",
      "13",
      "rollout-2026-05-13T00-00-00-000Z-abc123.jsonl",
    );
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
    return file;
  }

  function hostRollout(hostHome: string): string {
    return join(
      hostHome,
      "sessions",
      "2026",
      "05",
      "13",
      "rollout-2026-05-13T00-00-00-000Z-abc123.jsonl",
    );
  }

  it("copies Codex rollouts and removes a clean session", async () => {
    const sessionDir = join(root, "sessions", "codex-0001");
    const hostHome = join(root, "host-codex");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(hostHome, { recursive: true });
    writeManifest(sessionDir, codexManifest(sessionDir, hostHome));
    writeCodexRollout(sessionDir);

    const result = await handoff(sessionDir, "test", () => {});

    expect(result.codexSessionsCopied).toBe(1);
    expect(readFileSync(hostRollout(hostHome), "utf8")).toBe("{\"type\":\"session\"}\n");
    expect(result.preserved).toBe(false);
    expect(result.removed).toBe(true);
    expect(existsSync(sessionDir)).toBe(false);
  });

  it("preserves the session when Codex rollout copy-out is unsafe", async () => {
    const sessionDir = join(root, "sessions", "codex-0002");
    const hostHome = join(root, "host-codex");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(hostHome, { recursive: true });
    writeManifest(sessionDir, codexManifest(sessionDir, hostHome));
    writeCodexRollout(sessionDir);
    writeFileSync(
      join(sessionDir, "codex-sessions", "2026", "05", "13", "notes.txt"),
      "unexpected",
    );

    const result = await handoff(sessionDir, "test", () => {});

    expect(result.preserved).toBe(true);
    expect(result.removed).toBe(false);
    expect(existsSync(sessionDir)).toBe(true);
    expect(result.warnings.join("\n")).toContain("Codex session copy-out");
    expect(result.warnings.join("\n")).toContain("Codex rollout files can be inspected");
    expect(result.warnings.join("\n")).not.toContain("git status");
    expect(existsSync(join(hostHome, "sessions"))).toBe(false);
  });

  it("preserves the session on changed Codex rollout collisions", async () => {
    const sessionDir = join(root, "sessions", "codex-0003");
    const hostHome = join(root, "host-codex");
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(hostHome, "sessions", "2026", "05", "13"), { recursive: true });
    writeManifest(sessionDir, codexManifest(sessionDir, hostHome));
    writeCodexRollout(sessionDir);
    writeFileSync(hostRollout(hostHome), "{\"type\":\"different\"}\n");

    const result = await handoff(sessionDir, "test", () => {});

    expect(result.preserved).toBe(true);
    expect(readFileSync(hostRollout(hostHome), "utf8")).toBe("{\"type\":\"different\"}\n");
  });
});
