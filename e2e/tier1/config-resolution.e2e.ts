/**
 * Tier-1 E2E tests for config file loading, profile selection, and
 * workspace-anchor path resolution. These tests spawn dist/cli.js — no mocks,
 * no docker required.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkTmpHome, seedGitRepo, seedClaudeHome, runCli } from "../../e2e/helpers/env.js";
import * as path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";

describe("config resolution e2e", () => {
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
  // Profile selection
  // ---------------------------------------------------------------------------

  it("--profile with a valid profile file loads without error (inspect)", async () => {
    const repoPath = await seedGitRepo(home, "profile-repo");
    await seedClaudeHome(home);

    // Create a named profile config
    const profileDir = path.join(repoPath, ".ccairgap");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(
      path.join(profileDir, "staging.config.yaml"),
      "# staging profile\nkeep-container: false\n",
    );

    const result = await runCli(
      ["inspect", "--repo", repoPath, "--profile", "staging"],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    // Should not error on config loading; inspect exits 0 regardless of profile content
    expect(result.exitCode).toBe(0);
    // Output should be valid JSON
    const parsed = JSON.parse(result.stdout) as unknown;
    expect(parsed).toMatchObject({ hooks: expect.any(Array) });
  });

  it("--profile nonexistent exits non-zero with a clear error", async () => {
    const repoPath = await seedGitRepo(home, "profile-repo");
    await seedClaudeHome(home);

    // The root command (no subcommand) validates --profile before reaching launch.
    // Passing --repo avoids the "not in a git repo" error and triggers the profile
    // lookup error instead. Docker is not needed for this validation phase.
    const result = await runCli(
      ["--profile", "nonexistent", "--repo", repoPath],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--profile nonexistent.*config file not found/i);
  });

  it("--config and --profile together exit non-zero (mutually exclusive)", async () => {
    const repoPath = await seedGitRepo(home, "mutex-repo");
    await seedClaudeHome(home);

    const cfgPath = path.join(home, "my-config.yaml");
    writeFileSync(cfgPath, "");

    // The root command enforces the mutex check before reaching launch.
    const result = await runCli(
      ["--config", cfgPath, "--profile", "staging", "--repo", repoPath],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/mutually exclusive/i);
  });

  // ---------------------------------------------------------------------------
  // Invalid config keys
  // ---------------------------------------------------------------------------

  it("config file with an unknown key causes non-zero exit", async () => {
    const repoPath = await seedGitRepo(home, "bad-config-repo");
    await seedClaudeHome(home);

    const configDir = path.join(repoPath, ".ccairgap");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.yaml"),
      "unknown-key: foo\n",
    );

    // The launch flow loads config before anything else, so this should fail fast
    const result = await runCli(
      // Use inspect since it doesn't need docker and loads the config
      ["inspect", "--repo", repoPath],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/unknown key.*unknown-key/i);
  });

  it("config file with wrong type for a boolean key causes non-zero exit", async () => {
    const repoPath = await seedGitRepo(home, "bad-type-repo");
    await seedClaudeHome(home);

    const configDir = path.join(repoPath, ".ccairgap");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.yaml"),
      'keep-container: "yes"\n', // should be boolean
    );

    const result = await runCli(
      ["inspect", "--repo", repoPath],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/expected boolean/i);
  });

  // ---------------------------------------------------------------------------
  // Valid config keys
  // ---------------------------------------------------------------------------

  it("config file with valid keys is accepted (no-preserve-dirty: true)", async () => {
    const repoPath = await seedGitRepo(home, "valid-config-repo");
    await seedClaudeHome(home);

    const configDir = path.join(repoPath, ".ccairgap");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.yaml"),
      "no-preserve-dirty: true\n",
    );

    const result = await runCli(
      ["inspect", "--repo", repoPath],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    // inspect loads the config and exits 0 for a valid config
    expect(result.exitCode).toBe(0);
  });

  it("config file with camelCase keys is accepted", async () => {
    const repoPath = await seedGitRepo(home, "camelcase-repo");
    await seedClaudeHome(home);

    const configDir = path.join(repoPath, ".ccairgap");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      path.join(configDir, "config.yaml"),
      "keepContainer: false\nnoPreserveDirty: true\n",
    );

    const result = await runCli(
      ["inspect", "--repo", repoPath],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Explicit --config path
  // ---------------------------------------------------------------------------

  it("explicit --config path loads config from arbitrary location", async () => {
    const repoPath = await seedGitRepo(home, "explicit-config-repo");
    await seedClaudeHome(home);

    const cfgPath = path.join(home, "custom-config.yaml");
    writeFileSync(cfgPath, "keep-container: false\n");

    const result = await runCli(
      ["inspect", "--repo", repoPath, "--config", cfgPath],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).toBe(0);
  });

  it("explicit --config with nonexistent file exits non-zero", async () => {
    const repoPath = await seedGitRepo(home, "missing-config-repo");
    await seedClaudeHome(home);

    // The root command validates --config before reaching launch, so docker is
    // not needed. The error occurs at config-load time (before binary preflight).
    const result = await runCli(
      ["--config", "/nonexistent/path/config.yaml", "--repo", repoPath],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--config file not found/i);
  });

  // ---------------------------------------------------------------------------
  // .config/ccairgap/ alternate layout
  // ---------------------------------------------------------------------------

  it("config at .config/ccairgap/config.yaml is discovered automatically", async () => {
    const repoPath = await seedGitRepo(home, "alt-layout-repo");
    await seedClaudeHome(home);

    const altConfigDir = path.join(repoPath, ".config", "ccairgap");
    mkdirSync(altConfigDir, { recursive: true });
    writeFileSync(
      path.join(altConfigDir, "config.yaml"),
      "keep-container: false\n",
    );

    const result = await runCli(
      ["inspect", "--repo", repoPath],
      {
        env: { HOME: home, CCAIRGAP_HOME: ccairgapHome },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).toBe(0);
  });
});
