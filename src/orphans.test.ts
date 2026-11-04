import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { scanOrphans } from "./orphans.js";
import { listOrphans } from "./subcommands.js";
import { sanitizeSessionClone } from "./sessionCloneTrust.js";
import { writeManifest, type Manifest } from "./manifest.js";

let root: string;
let savedEnv: { CCAIRGAP_HOME?: string };

function git(args: string[], cwd: string): void {
  execaSync("git", args, { cwd, stdio: "pipe" });
}

function seedSession(opts: {
  stateRoot: string;
  id: string;
  hostRepo: string;
  altName: string;
  branch: string;
}): { sessionDir: string; clone: string } {
  const sessionDir = join(opts.stateRoot, "sessions", opts.id);
  mkdirSync(join(sessionDir, "repos"), { recursive: true });
  const clone = join(sessionDir, "repos", opts.altName);
  execaSync("git", ["clone", "--shared", "-q", opts.hostRepo, clone], {
    stdio: "pipe",
  });
  git(["config", "user.email", "t@t"], clone);
  git(["config", "user.name", "t"], clone);
  git(["checkout", "-q", "-b", opts.branch], clone);
  const m: Manifest = {
    version: 1,
    cli_version: "test",
    image_tag: "test:1",
    created_at: new Date().toISOString(),
    repos: [
      {
        basename: "hostrepo",
        host_path: opts.hostRepo,
        alternates_name: opts.altName,
      },
    ],
    branch: opts.branch,
    claude_code: {},
  };
  writeManifest(sessionDir, m);
  return { sessionDir, clone };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-orphans-")));
  savedEnv = { CCAIRGAP_HOME: process.env.CCAIRGAP_HOME };
  process.env.CCAIRGAP_HOME = root;

  const hostRepo = join(root, "hostrepo");
  mkdirSync(hostRepo, { recursive: true });
  git(["init", "-q", "-b", "main"], hostRepo);
  git(["config", "user.email", "t@t"], hostRepo);
  git(["config", "user.name", "t"], hostRepo);
  writeFileSync(join(hostRepo, "seed.txt"), "seed\n");
  git(["add", "seed.txt"], hostRepo);
  git(["commit", "-qm", "seed"], hostRepo);
});

afterEach(() => {
  if (savedEnv.CCAIRGAP_HOME === undefined) delete process.env.CCAIRGAP_HOME;
  else process.env.CCAIRGAP_HOME = savedEnv.CCAIRGAP_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe("scanOrphans dirty counts", () => {
  it("reports modified and untracked counts per repo", async () => {
    const hostRepo = join(root, "hostrepo");
    const { clone, sessionDir } = seedSession({
      stateRoot: root,
      id: "orph-a1b2",
      hostRepo,
      altName: "hostrepo-00000000",
      branch: "ccairgap/orph-a1b2",
    });
    writeFileSync(join(clone, "seed.txt"), "edited\n");
    writeFileSync(join(clone, "untracked.txt"), "x\n");
    await sanitizeSessionClone({
      sessionDir,
      name: "hostrepo-00000000",
      sessionClone: clone,
      hostPath: hostRepo,
    });

    const orphans = await scanOrphans("test");

    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.dirty).toEqual({
      hostrepo: { modified: 1, untracked: 1 },
    });
    expect(orphans[0]!.notScanned).toEqual([]);
  });

  it("runs no host git in an unsanitized clone, and reports it as not scanned", async () => {
    const hostRepo = join(root, "hostrepo");
    const { clone } = seedSession({
      stateRoot: root,
      id: "orph-e1f2",
      hostRepo,
      altName: "hostrepo-00000000",
      branch: "ccairgap/orph-e1f2",
    });
    const marker = join(root, "MARKER");
    git(["config", "core.fsmonitor", `touch ${marker}; true`], clone);
    writeFileSync(join(clone, "seed.txt"), "edited\n");

    const orphans = await scanOrphans("test");

    expect(existsSync(marker)).toBe(false);
    expect(orphans[0]!.notScanned).toEqual(["hostrepo"]);
    expect(orphans[0]!.dirty).toEqual({});
    expect(existsSync(join(clone, ".git", "config"))).toBe(true);
  });

  it("omits dirty entry for clean repo", async () => {
    const hostRepo = join(root, "hostrepo");
    seedSession({
      stateRoot: root,
      id: "orph-c1d2",
      hostRepo,
      altName: "hostrepo-00000000",
      branch: "ccairgap/orph-c1d2",
    });

    const orphans = await scanOrphans("test");

    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.dirty).toEqual({});
  });
});

describe("listOrphans output format", () => {
  it("renders a dirty segment when dirty counts are present", async () => {
    const hostRepo = join(root, "hostrepo");
    const { clone, sessionDir } = seedSession({
      stateRoot: root,
      id: "orph-fmt-01",
      hostRepo,
      altName: "hostrepo-00000000",
      branch: "ccairgap/orph-fmt-01",
    });
    writeFileSync(join(clone, "seed.txt"), "edited\n");
    await sanitizeSessionClone({
      sessionDir,
      name: "hostrepo-00000000",
      sessionClone: clone,
      hostPath: hostRepo,
    });

    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await listOrphans();
    } finally {
      console.log = orig;
    }

    const line = lines.find((l) => l.includes("orph-fmt-01"));
    expect(line).toBeDefined();
    expect(line!).toContain("dirty=hostrepo+1M/0U");
  });

  it("names repos that were not scanned", async () => {
    seedSession({
      stateRoot: root,
      id: "orph-fmt-02",
      hostRepo: join(root, "hostrepo"),
      altName: "hostrepo-00000000",
      branch: "ccairgap/orph-fmt-02",
    });

    const lines: string[] = [];
    const orig = console.log;
    console.log = (msg: string) => lines.push(msg);
    try {
      await listOrphans();
    } finally {
      console.log = orig;
    }

    expect(lines.find((l) => l.includes("orph-fmt-02"))!).toContain("not-scanned=hostrepo");
  });
});
