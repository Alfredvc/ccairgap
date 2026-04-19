import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execa } from "execa";
import {
  mkTmpHome,
  seedGitRepo,
  seedClaudeHome,
  runCli,
  cleanupContainers,
} from "../helpers/env";
import { dockerAvailable } from "../helpers/dockerAvailable";
import {
  assertBranchExists,
  assertSessionDirRemoved,
  testCmd,
} from "../helpers/assertions";

const FAKE_DOCKERFILE = "e2e/fixtures/fake.Dockerfile";

// On Linux, credentials come from ~/.claude/.credentials.json (not keychain).
// Pre-create it so the credentials flow doesn't fail.
async function seedCredentials(home: string): Promise<void> {
  const claudeDir = path.join(home, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(path.join(claudeDir, ".credentials.json"), "{}");
}

describe.skipIf(!(await dockerAvailable()))("launch-basic tier2", () => {
  let home: string;
  let ccairgapHome: string;
  let cleanup: () => Promise<void>;
  let repo: string;
  let sessionId: string | null;

  beforeEach(async () => {
    ({ home, ccairgapHome, cleanup } = await mkTmpHome());
    await seedClaudeHome(home);
    if (os.platform() === "linux") {
      await seedCredentials(home);
    }
    repo = await seedGitRepo(home, "myapp");
    sessionId = null;
  });

  afterEach(async () => {
    if (sessionId) await cleanupContainers(sessionId);
    await cleanup();
  });

  it("exit 0 → session dir removed", async () => {
    const result = await runCli(
      [
        "--repo", repo,
        "--dockerfile", FAKE_DOCKERFILE,
        "--no-preserve-dirty",
        ...testCmd("exit 0"),
      ],
      { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome } },
    );

    sessionId = result.sessionId;
    expect(result.exitCode).toBe(0);
    await assertSessionDirRemoved(ccairgapHome, result.sessionId);
  });

  it("exit 0 → handoff branch on host", async () => {
    // Make an empty commit so the sandbox branch has at least one commit
    // ahead of origin. Handoff only calls git-fetch when sandboxCommitCount > 0
    // (see handoff.ts); with 0 commits the branch is not created on the host.
    // The container CWD is already the repo root (CCAIRGAP_CWD), so no cd needed.
    const result = await runCli(
      [
        "--repo", repo,
        "--dockerfile", FAKE_DOCKERFILE,
        "--no-preserve-dirty",
        ...testCmd("git commit --allow-empty -m handoff-branch-test && exit 0"),
      ],
      { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome } },
    );

    sessionId = result.sessionId;
    expect(result.exitCode).toBe(0);
    // The handoff git-fetches the ccairgap/<id> branch from the session clone
    // into the host repo. With at least one commit on the sandbox branch,
    // gitFetchSandbox runs and creates the branch on the host.
    await assertBranchExists(repo, /^ccairgap\//);
  });

  it("container commit lands on host branch", async () => {
    // The container makes an empty commit and exits 0. On handoff, git fetch
    // brings that commit into the host repo under ccairgap/<id>.
    // The container CWD is already the repo root (CCAIRGAP_CWD), so no cd needed.
    const result = await runCli(
      [
        "--repo", repo,
        "--dockerfile", FAKE_DOCKERFILE,
        "--no-preserve-dirty",
        ...testCmd("git commit --allow-empty -m e2e-test-commit && exit 0"),
      ],
      { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome } },
    );

    sessionId = result.sessionId;
    expect(result.exitCode).toBe(0);

    // The branch must exist on the host.
    await assertBranchExists(repo, /^ccairgap\//);

    // Find the branch name and check the commit log for the test message.
    const { stdout: branchOut } = await execa("git", ["branch", "-a"], { cwd: repo });
    const branches = branchOut
      .split("\n")
      .map((l) => l.replace(/^\*?\s+/, "").trim())
      .filter((b) => /^ccairgap\//.test(b));

    expect(branches.length).toBeGreaterThan(0);

    const branchName = branches[0]!;
    const { stdout: logOut } = await execa("git", ["log", "--oneline", branchName], {
      cwd: repo,
    });
    expect(logOut).toContain("e2e-test-commit");
  });

  it("non-zero exit → exit code propagated, session removed when clean", async () => {
    // When the container exits with a non-zero code and the session clone is
    // clean (no uncommitted changes, no orphan branches), handoff still removes
    // the session dir. The CLI propagates the container exit code to its own
    // exit code. This verifies that exit code passthrough works correctly.
    const result = await runCli(
      [
        "--repo", repo,
        "--dockerfile", FAKE_DOCKERFILE,
        "--no-preserve-dirty",
        ...testCmd("exit 1"),
      ],
      { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome } },
    );

    sessionId = result.sessionId;

    // The container exited with 1; the CLI must propagate it.
    expect(result.exitCode).not.toBe(0);

    // The session clone is clean (no commits, no dirty files), so handoff
    // removes the session dir — same as a clean exit 0.
    await assertSessionDirRemoved(ccairgapHome, result.sessionId);
  });
});
