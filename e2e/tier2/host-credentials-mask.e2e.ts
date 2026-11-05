import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { lstatSync, readdirSync, symlinkSync, renameSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
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
// Takes the file-based credentials branch on all hosts, as launch-basic does.
const NODE_OPTIONS = `--require ${resolve("e2e/helpers/force-linux.cjs")}`;

/**
 * The agent must not read the host refresh token through any path. The session
 * credentials file has it stripped, but host `~/.claude/` is also mounted at
 * /host-claude, and a Linux host keeps the raw token in a file there.
 */
describe.skipIf(!(await dockerAvailable()))("host credentials mask", () => {
  let home: string;
  let ccairgapHome: string;
  let cleanup: () => Promise<void>;
  let repo: string;

  beforeEach(async () => {
    ({ home, ccairgapHome, cleanup } = await mkTmpHome());
    await seedClaudeHome(home);
    await seedHostCreds(home, { refreshToken: "e2e-host-rt" });
    repo = await seedGitRepo(home, "myapp");
  });

  afterEach(async () => {
    for (const id of readdirSafe(join(ccairgapHome, "sessions"))) await cleanupContainers(id);
    await cleanup();
  });

  const launch = async (script: string) =>
    runCli(
      ["--repo", repo, "--dockerfile", FAKE_DOCKERFILE, "--no-preserve-dirty", "--print", "x", ...testCmd(script)],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome, NODE_OPTIONS },
        timeout: 180_000,
      },
    );

  // grep exits 1 when no file under /host-claude holds the token.
  const NO_TOKEN = `! grep -rq e2e-host-rt /host-claude/ && ! grep -q e2e-host-rt /host-claude-creds-dir/.credentials.json`;

  it("hides the token in the host credentials file", async () => {
    const result = await launch(NO_TOKEN);
    expect(result.exitCode, result.stderr).toBe(0);
  }, 200_000);

  it("hides the token when the credentials file is a symlink inside the config dir", async () => {
    const dir = join(home, ".claude");
    mkdirSync(join(dir, "vault"));
    renameSync(join(dir, ".credentials.json"), join(dir, "vault", "real.json"));
    symlinkSync("vault/real.json", join(dir, ".credentials.json"));
    expect(lstatSync(join(dir, ".credentials.json")).isSymbolicLink()).toBe(true);
    const result = await launch(NO_TOKEN);
    expect(result.exitCode, result.stderr).toBe(0);
  }, 200_000);
});

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}
