/**
 * Tier-1 E2E tests for subcommands: init, list, doctor, inspect, discard.
 * These tests spawn dist/cli.js directly — no mocks, no docker required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkTmpHome, seedGitRepo, seedClaudeHome, runCli } from "../../e2e/helpers/env.js";
import { assertFileExists, assertFileContains } from "../../e2e/helpers/assertions.js";
import * as fs from "fs/promises";
import * as path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

describe("subcommands e2e", () => {
  let home: string;
  let ccairgapHome: string;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    ({ home, ccairgapHome, cleanup } = await mkTmpHome());
  });

  afterEach(async () => {
    await cleanup();
  });

  // ---------------------------------------------------------------------------
  // init
  // ---------------------------------------------------------------------------

  it("init creates .ccairgap/config.yaml in a git repo", async () => {
    const repoPath = await seedGitRepo(home, "test-repo");
    await seedClaudeHome(home);

    const result = await runCli(["init"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
      cwd: repoPath,
    });

    expect(result.exitCode).toBe(0);

    const configPath = path.join(repoPath, ".ccairgap", "config.yaml");
    await assertFileExists(configPath);
    await assertFileContains(configPath, "dockerfile");

    const dockerfilePath = path.join(repoPath, ".ccairgap", "Dockerfile");
    await assertFileExists(dockerfilePath);

    const entrypointPath = path.join(repoPath, ".ccairgap", "entrypoint.sh");
    await assertFileExists(entrypointPath);
  });

  it("init exits non-zero outside a git repo (no --config)", async () => {
    // A fresh temp dir that is not a git repo
    const nonRepoPath = path.join(home, "not-a-repo");
    mkdirSync(nonRepoPath, { recursive: true });
    await seedClaudeHome(home);

    const result = await runCli(["init"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
      cwd: nonRepoPath,
    });

    expect(result.exitCode).not.toBe(0);
    // Should mention "not in a git repo"
    expect(result.stderr).toMatch(/not in a git repo/i);
  });

  it("init --force overwrites existing config.yaml", async () => {
    const repoPath = await seedGitRepo(home, "test-repo");
    await seedClaudeHome(home);

    // First init
    const first = await runCli(["init"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
      cwd: repoPath,
    });
    expect(first.exitCode).toBe(0);

    // Second init without --force should fail
    const second = await runCli(["init"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
      cwd: repoPath,
    });
    expect(second.exitCode).not.toBe(0);
    expect(second.stderr).toMatch(/refusing to overwrite/i);

    // Third init with --force should succeed
    const third = await runCli(["init", "--force"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
      cwd: repoPath,
    });
    expect(third.exitCode).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // list
  // ---------------------------------------------------------------------------

  it("list shows pre-seeded session in CCAIRGAP_HOME", async () => {
    const sessionId = "test-session-abcd";
    const sessionPath = path.join(ccairgapHome, "sessions", sessionId);
    mkdirSync(sessionPath, { recursive: true });

    const manifest = {
      version: 1,
      cli_version: "0.3.0",
      image_tag: "ccairgap:0.3.0-test",
      created_at: new Date().toISOString(),
      repos: [],
      branch: `ccairgap/${sessionId}`,
      claude_code: {},
    };
    writeFileSync(
      path.join(sessionPath, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    await seedClaudeHome(home);

    const result = await runCli(["list"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(sessionId);
  });

  it("list says 'no orphaned sessions' when state dir is empty", async () => {
    await seedClaudeHome(home);

    const result = await runCli(["list"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("no orphaned sessions");
  });

  // ---------------------------------------------------------------------------
  // doctor
  // ---------------------------------------------------------------------------

  it("doctor runs without crashing and mentions git and docker", async () => {
    await seedClaudeHome(home);

    const result = await runCli(["doctor"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
    });

    // doctor exits 0 or 1 depending on whether docker is available
    // but it must not throw / produce no output
    const output = result.stdout + result.stderr;
    expect(output).toMatch(/docker/i);
    expect(output).toMatch(/git/i);
    // It must print at least some check lines
    expect(output).toMatch(/\[(OK|FAIL|WARN)\]/);
  });

  it("doctor reports state dir as writable", async () => {
    await seedClaudeHome(home);

    const result = await runCli(["doctor"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
    });

    const output = result.stdout + result.stderr;
    expect(output).toMatch(/state dir/i);
    expect(output).toMatch(/writable/i);
  });

  // ---------------------------------------------------------------------------
  // inspect
  // ---------------------------------------------------------------------------

  it("inspect exits 0 and emits JSON with expected shape", async () => {
    await seedClaudeHome(home, { settings: {} });
    const repoPath = await seedGitRepo(home, "inspect-repo");

    const result = await runCli(["inspect", "--repo", repoPath], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
      cwd: repoPath,
    });

    expect(result.exitCode).toBe(0);
    // Output should be valid JSON with the expected shape
    const parsed = JSON.parse(result.stdout) as unknown;
    expect(parsed).toMatchObject({
      hooks: expect.any(Array),
      mcpServers: expect.any(Array),
    });
  });

  it("inspect --pretty exits 0 and prints non-JSON text", async () => {
    await seedClaudeHome(home, { settings: {} });
    const repoPath = await seedGitRepo(home, "inspect-repo");

    const result = await runCli(["inspect", "--repo", repoPath, "--pretty"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
      cwd: repoPath,
    });

    expect(result.exitCode).toBe(0);
    // Should not be parseable as JSON (it's a human-readable table)
    expect(() => JSON.parse(result.stdout)).toThrow();
    // Should have some output
    expect(result.stdout.length).toBeGreaterThan(0);
  });

  // ---------------------------------------------------------------------------
  // discard
  // ---------------------------------------------------------------------------

  it("discard removes a pre-seeded session dir", async () => {
    const sessionId = "discard-test-1a2b";
    const sessionPath = path.join(ccairgapHome, "sessions", sessionId);
    mkdirSync(sessionPath, { recursive: true });

    const manifest = {
      version: 1,
      cli_version: "0.3.0",
      image_tag: "ccairgap:0.3.0-test",
      created_at: new Date().toISOString(),
      repos: [],
      branch: `ccairgap/${sessionId}`,
      claude_code: {},
    };
    writeFileSync(
      path.join(sessionPath, "manifest.json"),
      JSON.stringify(manifest, null, 2),
    );

    await seedClaudeHome(home);

    const result = await runCli(["discard", sessionId], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`discarded ${sessionId}`);

    // Session dir must no longer exist
    let exists = true;
    try {
      await fs.access(sessionPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it("discard exits non-zero for a session that does not exist", async () => {
    await seedClaudeHome(home);

    const result = await runCli(["discard", "no-such-session-0000"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/no session dir/i);
  });

  it("list shows multiple pre-seeded sessions", async () => {
    await seedClaudeHome(home);

    const ids = ["alpha-session-aaaa", "beta-session-bbbb"];
    for (const sessionId of ids) {
      const sessionPath = path.join(ccairgapHome, "sessions", sessionId);
      mkdirSync(sessionPath, { recursive: true });
      const manifest = {
        version: 1,
        cli_version: "0.3.0",
        image_tag: "ccairgap:0.3.0-test",
        created_at: new Date().toISOString(),
        repos: [],
        branch: `ccairgap/${sessionId}`,
        claude_code: {},
      };
      writeFileSync(
        path.join(sessionPath, "manifest.json"),
        JSON.stringify(manifest, null, 2),
      );
    }

    const result = await runCli(["list"], {
      env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
    });

    expect(result.exitCode).toBe(0);
    for (const id of ids) {
      expect(result.stdout).toContain(id);
    }
  });
});
