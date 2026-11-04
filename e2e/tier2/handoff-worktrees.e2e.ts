import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
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
const FORCE_LINUX_PRELOAD = resolve("e2e/helpers/force-linux.cjs");
const TIER2_NODE_OPTIONS = `--require ${FORCE_LINUX_PRELOAD}`;
const IDENTITY = "-c user.email=t@t -c user.name=t";

describe.skipIf(!(await dockerAvailable()))("linked worktree handoff tier2", () => {
  let home: string;
  let ccairgapHome: string;
  let cleanup: () => Promise<void>;
  let repo: string;
  let sessionId: string | null;

  const run = (script: string) =>
    runCli(
      ["--repo", repo, "--dockerfile", FAKE_DOCKERFILE, "--print", "smoke", ...testCmd(script)],
      {
        env: {
          HOME: home,
          CCAIRGAP_HOME: ccairgapHome,
          NODE_OPTIONS: TIER2_NODE_OPTIONS,
        },
      },
    );

  const hostBranches = async () =>
    (await execa("git", ["-C", repo, "for-each-ref", "--format=%(refname:short)", "refs/heads/"]))
      .stdout.split("\n");

  beforeEach(async () => {
    ({ home, ccairgapHome, cleanup } = await mkTmpHome());
    await seedClaudeHome(home);
    await seedHostCreds(home);
    repo = await seedGitRepo(home, "myapp");
    sessionId = null;
  });

  afterEach(async () => {
    if (sessionId) await cleanupContainers(sessionId);
    await cleanup();
  });

  it("delivers a commit made in a worktree that the container created", async () => {
    const result = await run(
      "git worktree add -q -b wt1 .claude/worktrees/x" +
        " && cd .claude/worktrees/x && echo hi > c.txt && git add c.txt" +
        ` && git ${IDENTITY} commit -qm c`,
    );
    sessionId = result.sessionId;

    expect(result.exitCode).toBe(0);
    const delivered = `ccairgap/${sessionId}-worktrees/wt1`;
    expect(await hostBranches()).toContain(delivered);
    const { stdout } = await execa("git", ["-C", repo, "show", `${delivered}:c.txt`]);
    expect(stdout).toBe("hi");
    expect(await readdir(join(ccairgapHome, "sessions"))).toEqual([]);
  });

  it("preserves uncommitted files in a container worktree and points them at the host", async () => {
    const result = await run(
      "git worktree add -q -b wt1 .claude/worktrees/x && echo hi > .claude/worktrees/x/u.txt",
    );
    sessionId = result.sessionId;

    expect(result.stderr).toContain("uncommitted changes in linked worktree");
    const sessions = await readdir(join(ccairgapHome, "sessions"));
    expect(sessions).toHaveLength(1);

    const wt = join(
      ccairgapHome,
      "sessions",
      sessions[0]!,
      "repos",
      (await readdir(join(ccairgapHome, "sessions", sessions[0]!, "repos")))[0]!,
      ".claude/worktrees/x",
    );
    expect(await readFile(join(wt, "u.txt"), "utf8")).toBe("hi\n");
    const { stdout } = await execa("git", ["-C", wt, "status", "--short"]);
    expect(stdout).toContain("u.txt");
  });
});
