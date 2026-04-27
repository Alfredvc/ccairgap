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

/**
 * 100 atomic-rename cycles vs in-container `cat` loop. Asserts: at no point
 * does `jq` see invalid JSON. Confirms VirtioFS / overlay2 rename(2)
 * atomicity for the directory bind mount.
 */
describe.skipIf(!(await dockerAvailable()) || os.platform() !== "linux")(
  "auth-refresh rename-atomicity tier2",
  () => {
    let home: string;
    let ccairgapHome: string;
    let cleanup: () => Promise<void>;
    let repo: string;
    let sessionId: string | null;

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

    it("zero torn reads across 100 rename cycles", async () => {
      const script = [
        "for _ in $(seq 1 1000); do",
        "  jq -e .claudeAiOauth.accessToken /host-claude-creds-dir/.credentials.json >/dev/null \\",
        "    || { echo TORN >&2; exit 1; }",
        "  if [ -f /tmp/done ]; then exit 0; fi",
        "done",
        // If we exit the loop without /tmp/done, something else went wrong upstream.
        "echo loop-exhausted >&2; exit 1",
      ].join(" ");

      const cliPromise = runCli(
        [
          "--repo", repo,
          "--dockerfile", FAKE_DOCKERFILE,
          "--no-preserve-dirty",
          // Long-lived test container so we have time to rotate creds.
          "--docker-run-arg", "-v /tmp:/tmp",
          ...testCmd(script),
        ],
        { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome }, timeout: 90_000 },
      );

      // Locate session dir
      const sessionsDir = path.join(ccairgapHome, "sessions");
      let sd: string | undefined;
      for (let i = 0; i < 100; i++) {
        try {
          const entries = await fs.readdir(sessionsDir);
          if (entries.length > 0) {
            sd = path.join(sessionsDir, entries[0]!);
            break;
          }
        } catch {
          // keep trying
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(sd, "session dir never created").toBeDefined();

      const credsPath = path.join(sd!, "creds", ".credentials.json");
      // Wait for entrypoint to symlink it.
      for (let i = 0; i < 50; i++) {
        try {
          await fs.access(credsPath);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // Rotate 100 times.
      for (let i = 0; i < 100; i++) {
        const json = JSON.stringify({
          claudeAiOauth: {
            accessToken: `rot-${i}`,
            expiresAt: Date.now() + 8 * 60 * 60_000,
            scopes: ["user:inference"],
          },
        });
        const tmp = `${credsPath}.tmp.${i}`;
        await fs.writeFile(tmp, json, { mode: 0o600 });
        await fs.rename(tmp, credsPath);
        await new Promise((r) => setTimeout(r, 5));
      }

      // Signal the container to exit.
      await fs.writeFile("/tmp/done", "");

      const result = await cliPromise;
      sessionId = result.sessionId;
      expect(result.stderr).not.toMatch(/TORN/);
      expect(result.exitCode).toBe(0);

      // Cleanup the marker
      await fs.rm("/tmp/done", { force: true });
    });
  },
);
