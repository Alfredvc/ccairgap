import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as os from "os";
import * as fs from "fs/promises";
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

describe.skipIf(!(await dockerAvailable()) || os.platform() !== "linux")(
  "auth-refresh runtime tier2",
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

    it("creds dir is RW-mounted; container reads bind-mount path directly", async () => {
      const script = [
        // Confirm the directory mount is reachable + RW from the container side
        '[ -d /host-claude-creds-dir ] || { echo "no dir mount" >&2; exit 1; }',
        // Confirm the file inside is readable + the content survived strip
        'jq -e ".claudeAiOauth.accessToken == \\"e2e-at\\"" /host-claude-creds-dir/.credentials.json >/dev/null',
        'jq -e ".claudeAiOauth.refreshToken == null" /host-claude-creds-dir/.credentials.json >/dev/null',
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
        `bind-mount test failed. stdout=${result.stdout} stderr=${result.stderr}`,
      ).toBe(0);
    });

    it("host-side atomic rewrite of session creds is visible inside the container", async () => {
      // Container script: poll the bind-mount path for up to 5 seconds.
      const script = [
        "for _ in $(seq 1 25); do",
        "  TOK=$(jq -r .claudeAiOauth.accessToken /host-claude-creds-dir/.credentials.json 2>/dev/null)",
        "  if [ \"$TOK\" = \"second-at\" ]; then exit 0; fi",
        "  sleep 0.2",
        "done",
        "echo timeout >&2; exit 1",
      ].join(" ");

      // Spawn the CLI in the background (no await) so we can rewrite the
      // host file while the container is running.
      const cliPromise = runCli(
        [
          "--repo", repo,
          "--dockerfile", FAKE_DOCKERFILE,
          "--no-preserve-dirty",
          ...testCmd(script),
        ],
        { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome }, timeout: 60_000 },
      );

      const sessionsDir = path.join(ccairgapHome, "sessions");
      let sd: string | undefined;
      for (let i = 0; i < 50; i++) {
        try {
          const entries = await fs.readdir(sessionsDir);
          if (entries.length > 0) {
            sd = path.join(sessionsDir, entries[0]!);
            break;
          }
        } catch {
          // dir not created yet
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(sd, "session dir never created").toBeDefined();

      const credsPath = path.join(sd!, "creds", ".credentials.json");
      for (let i = 0; i < 50; i++) {
        try {
          await fs.access(credsPath);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 200));
        }
      }
      const newJson = JSON.stringify({
        claudeAiOauth: {
          accessToken: "second-at",
          expiresAt: Date.now() + 8 * 60 * 60_000,
          scopes: ["user:inference"],
        },
      });
      const tmp = `${credsPath}.tmp.test`;
      await fs.writeFile(tmp, newJson, { mode: 0o600 });
      await fs.rename(tmp, credsPath);

      const result = await cliPromise;
      sessionId = result.sessionId;
      expect(result.exitCode).toBe(0);
    });
  },
);
