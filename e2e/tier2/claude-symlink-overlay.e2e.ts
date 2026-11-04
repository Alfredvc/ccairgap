import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmod, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import * as path from "path";
import {
  mkTmpHome,
  seedGitRepo,
  seedClaudeHome,
  seedHostCreds,
  runCli,
  cleanupContainers,
} from "../helpers/env";
import { dockerAvailable } from "../helpers/dockerAvailable";
import { testCmd } from "../helpers/assertions";

const FAKE_DOCKERFILE = "e2e/fixtures/fake.Dockerfile";
const FORCE_LINUX_PRELOAD = path.resolve("e2e/helpers/force-linux.cjs");
const TIER2_NODE_OPTIONS = `--require ${FORCE_LINUX_PRELOAD}`;

describe.skipIf(!(await dockerAvailable()))("~/.claude symlink overlay tier2", () => {
  let home: string;
  let ccairgapHome: string;
  let cleanup: () => Promise<void>;
  let repo: string;
  let sessionId: string | null;
  let unreadable: string | null;

  const env = () => ({
    HOME: home,
    CCAIRGAP_HOME: ccairgapHome,
    NODE_OPTIONS: TIER2_NODE_OPTIONS,
  });

  beforeEach(async () => {
    ({ home, ccairgapHome, cleanup } = await mkTmpHome());
    await seedClaudeHome(home);
    await seedHostCreds(home);
    repo = await seedGitRepo(home, "myapp");
    sessionId = null;
    unreadable = null;
  });

  afterEach(async () => {
    if (sessionId) await cleanupContainers(sessionId);
    if (unreadable) await chmod(unreadable, 0o600);
    await cleanup();
  });

  it("materializes skills/ symlinks and leaves jobs/ symlinks alone", async () => {
    const external = path.join(home, "external");
    await mkdir(path.join(external, "skill"), { recursive: true });
    await writeFile(path.join(external, "skill", "SKILL.md"), "skill\n");

    const claudeDir = path.join(home, ".claude");
    await mkdir(path.join(claudeDir, "skills"), { recursive: true });
    await symlink(path.join(external, "skill"), path.join(claudeDir, "skills", "s"));
    const bigRepo = path.join(external, "big-repo");
    await mkdir(bigRepo, { recursive: true });
    await writeFile(path.join(bigRepo, "marker"), "x\n");
    const jobSrc = path.join(claudeDir, "jobs", "j1", "tmp", "src");
    await mkdir(jobSrc, { recursive: true });
    await symlink(bigRepo, path.join(jobSrc, "big-repo"));

    // Docker follows a symlink at a mount destination, so a materialized target
    // appears at its own absolute path, and `test -L` stays true either way.
    // The marker must be absent at both the link path and the target path.
    const result = await runCli(
      [
        "--repo", repo,
        "--dockerfile", FAKE_DOCKERFILE,
        "--no-preserve-dirty", "--print", "smoke",
        ...testCmd(
          "test -f /host-claude/skills/s/SKILL.md" +
            " && ! test -e /host-claude/jobs/j1/tmp/src/big-repo/marker" +
            ` && ! test -e ${path.join(bigRepo, "marker")}`,
        ),
      ],
      { env: env() },
    );

    sessionId = result.sessionId;
    expect(result.exitCode).toBe(0);
  });

  it("removes the session dir when the overlay fails", async () => {
    // cp -L of an unreadable file target is a hard overlay failure.
    unreadable = path.join(home, "unreadable.md");
    await writeFile(unreadable, "secret\n");
    await chmod(unreadable, 0o000);
    const claudeMd = path.join(home, ".claude", "CLAUDE.md");
    await rm(claudeMd, { force: true });
    await symlink(unreadable, claudeMd);

    const result = await runCli(
      [
        "--repo", repo,
        "--dockerfile", FAKE_DOCKERFILE,
        "--no-preserve-dirty", "--print", "smoke",
        ...testCmd("exit 0"),
      ],
      { env: env() },
    );

    sessionId = result.sessionId;
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("failed to materialize ~/.claude/ symlink overlay");
    const sessions = await readdir(path.join(ccairgapHome, "sessions")).catch(() => []);
    expect(sessions).toEqual([]);
  });
});
