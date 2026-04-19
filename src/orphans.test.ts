import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
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
    const { clone } = seedSession({
      stateRoot: root,
      id: "orph-a1b2",
      hostRepo,
      altName: "hostrepo-00000000",
      branch: "ccairgap/orph-a1b2",
    });
    writeFileSync(join(clone, "seed.txt"), "edited\n");
    writeFileSync(join(clone, "untracked.txt"), "x\n");

    const orphans = await scanOrphans("test");

    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.dirty).toEqual({
      hostrepo: { modified: 1, untracked: 1 },
    });
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
    const { clone } = seedSession({
      stateRoot: root,
      id: "orph-fmt-01",
      hostRepo,
      altName: "hostrepo-00000000",
      branch: "ccairgap/orph-fmt-01",
    });
    writeFileSync(join(clone, "seed.txt"), "edited\n");

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
});
