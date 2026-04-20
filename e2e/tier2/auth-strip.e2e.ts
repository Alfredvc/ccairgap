import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
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

/**
 * Tier-2 e2e enforcement of the core invariant of the pre-launch-auth-refresh
 * design: the container's `.credentials.json` MUST NOT contain
 * `claudeAiOauth.refreshToken`. The host creds file is seeded with a
 * refresh token (`e2e-host-rt`); if any code path skips the strip step, the
 * in-container `jq` assertion below fails and the test exits non-zero.
 */
describe.skipIf(!(await dockerAvailable()) || os.platform() !== "linux")(
  "auth-strip tier2",
  () => {
    let home: string;
    let ccairgapHome: string;
    let cleanup: () => Promise<void>;
    let repo: string;
    let sessionId: string | null;

    beforeEach(async () => {
      ({ home, ccairgapHome, cleanup } = await mkTmpHome());
      await seedClaudeHome(home);
      await seedHostCreds(home, { refreshToken: "e2e-host-rt" });
      repo = await seedGitRepo(home, "myapp");
      sessionId = null;
    });

    afterEach(async () => {
      if (sessionId) await cleanupContainers(sessionId);
      await cleanup();
    });

    it("container creds file has refreshToken removed + accessToken preserved", async () => {
      // `jq -e` fails with non-zero if the expression is false/null. These
      // two assertions together prove the strip step ran without clobbering
      // sibling fields.
      const script = [
        'jq -e ".claudeAiOauth.refreshToken == null" ~/.claude/.credentials.json >/dev/null',
        'jq -e ".claudeAiOauth.accessToken == \\"e2e-at\\"" ~/.claude/.credentials.json >/dev/null',
        "exit 0",
      ].join(" && ");

      const result = await runCli(
        [
          "--repo", repo,
          "--dockerfile", FAKE_DOCKERFILE,
          "--no-preserve-dirty",
          ...testCmd(script),
        ],
        { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome } },
      );

      sessionId = result.sessionId;
      expect(
        result.exitCode,
        `strip invariant violated. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
    });

    it("refresh-below-ttl=0 still strips refreshToken", async () => {
      // --refresh-below-ttl 0 disables pre-launch refresh but the strip step
      // is an invariant, never toggled by user config.
      const script = [
        'jq -e ".claudeAiOauth.refreshToken == null" ~/.claude/.credentials.json >/dev/null',
        "exit 0",
      ].join(" && ");

      const result = await runCli(
        [
          "--repo", repo,
          "--dockerfile", FAKE_DOCKERFILE,
          "--refresh-below-ttl", "0",
          "--no-preserve-dirty",
          ...testCmd(script),
        ],
        { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome } },
      );

      sessionId = result.sessionId;
      expect(result.exitCode).toBe(0);
    });
  },
);
