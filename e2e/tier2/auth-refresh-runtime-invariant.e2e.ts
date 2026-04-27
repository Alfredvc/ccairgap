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
import { startMockAnthropic, type MockAnthropic } from "../helpers/mockAnthropic";

/**
 * Behavioral guard for upstream Claude Code's mtime-cache invalidation
 * (auth.ts:1320). If upstream removes that hook, this test fails — the
 * second `claude --print` would still send the original bearer.
 *
 * IMPORTANT: this test runs against the REAL Dockerfile (no --dockerfile
 * override) — fake.Dockerfile lacks the claude binary and skips the
 * entrypoint's `ln -sf` symlink step. The real image is heavy, so this is
 * an "on-demand" tier-2 test (manual / CI gate before release).
 */
describe.skipIf(!(await dockerAvailable()) || os.platform() !== "linux")(
  "auth-refresh runtime mtime-invariant tier2",
  () => {
    let home: string;
    let ccairgapHome: string;
    let cleanup: () => Promise<void>;
    let repo: string;
    let mock: MockAnthropic;
    let sessionId: string | null;

    beforeEach(async () => {
      ({ home, ccairgapHome, cleanup } = await mkTmpHome());
      await seedClaudeHome(home);
      await seedHostCreds(home, { accessToken: "first-at" });
      repo = await seedGitRepo(home, "myapp");
      mock = await startMockAnthropic();
      sessionId = null;
    });

    afterEach(async () => {
      if (sessionId) await cleanupContainers(sessionId);
      await mock.close();
      await cleanup();
    });

    it("second --print after host creds rewrite carries the new bearer", async () => {
      const baseUrl = mock.url.replace("127.0.0.1", "host.docker.internal");
      // The real entrypoint exec's `claude` by default. We override that with
      // CCAIRGAP_TEST_CMD (via testCmd()) so we can drive TWO sequential
      // `claude --print` calls inside the same container lifetime, with a
      // host-side creds rewrite between them. CCAIRGAP_TEST_CMD runs AFTER
      // the entrypoint's symlink step, so `~/.claude/.credentials.json` is
      // a symlink to `/host-claude-creds-dir/.credentials.json` by the time
      // the script starts.
      const script = [
        "claude --print 'say OK' >/dev/null 2>&1",
        // Wait for the host harness to swap the creds file.
        "while [ ! -f /tmp/swap-done ]; do sleep 0.1; done",
        "claude --print 'say OK again' >/dev/null 2>&1",
        "exit 0",
      ].join(" && ");

      const cliPromise = runCli(
        [
          "--repo", repo,
          "--no-preserve-dirty",
          // Real Dockerfile (no --dockerfile flag).
          "--docker-run-arg", `-e=ANTHROPIC_BASE_URL=${baseUrl}`,
          "--docker-run-arg", "--add-host=host.docker.internal:host-gateway",
          "--docker-run-arg", "-v=/tmp:/tmp",
          ...testCmd(script),
        ],
        { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome }, timeout: 180_000 },
      );

      const sessionsDir = path.join(ccairgapHome, "sessions");
      let sd: string | undefined;
      for (let i = 0; i < 200; i++) {
        try {
          const entries = await fs.readdir(sessionsDir);
          if (entries.length > 0) {
            sd = path.join(sessionsDir, entries[0]!);
            break;
          }
        } catch {
          // wait
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(sd, "session dir never created").toBeDefined();

      const credsPath = path.join(sd!, "creds", ".credentials.json");
      // Wait for first --print to land at the mock before swapping creds.
      // Poll observedBearers instead of a fixed sleep so this test scales
      // with real image cold-start latency on CI.
      for (let i = 0; i < 200; i++) {
        if (mock.observedBearers.includes("first-at")) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      expect(mock.observedBearers, "first --print never reached the mock").toContain("first-at");

      const newJson = JSON.stringify({
        claudeAiOauth: {
          accessToken: "second-at",
          expiresAt: Date.now() + 8 * 60 * 60_000,
          scopes: ["user:inference"],
        },
      });
      const tmp = `${credsPath}.tmp.swap`;
      await fs.writeFile(tmp, newJson, { mode: 0o600 });
      await fs.rename(tmp, credsPath);
      await fs.writeFile("/tmp/swap-done", "");

      const result = await cliPromise;
      sessionId = result.sessionId;

      await fs.rm("/tmp/swap-done", { force: true });

      expect(result.exitCode, `stderr=${result.stderr}`).toBe(0);
      expect(mock.observedBearers).toContain("first-at");
      expect(mock.observedBearers).toContain("second-at");
    });
  },
);
