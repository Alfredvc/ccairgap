/**
 * Tier-1 E2E tests for --resume argument resolution.
 *
 * These tests exercise:
 *   - UUID passthrough: a UUID arg is accepted without scanning transcripts
 *   - Name→UUID scan: a custom title is resolved to a UUID from transcript files
 *   - Bad name: non-zero exit with "no session with that name" message
 *   - Bad UUID: non-zero exit with "transcript not found" message
 *
 * Because the full launch pipeline requires docker, we inject a minimal fake
 * `docker` stub via PATH so that the binary preflight passes and the resume
 * validation code is reached. The tests assert on the specific error text
 * produced by the resume phase, not docker/image errors.
 *
 * Layout of Claude transcript files on disk:
 *   $HOME/.claude/projects/<encoded-path>/<uuid>.jsonl
 * where <encoded-path> = repoPath.replace(/\//g, "-")
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkTmpHome, seedGitRepo, seedClaudeHome, runCli } from "../../e2e/helpers/env.js";
import * as path from "node:path";
import { writeFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as fs from "fs/promises";

/** Encode a repo path the same way paths.ts#encodeCwd does. */
function encodeCwd(abs: string): string {
  return abs.replace(/\//g, "-");
}

/**
 * Create a temporary directory containing a minimal `docker` stub script that
 * exits 0 on any invocation. Returns the dir path. Caller is responsible for
 * cleanup.
 */
async function createFakeDockerBinDir(): Promise<string> {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "ccairgap-fake-bin-"));
  const dockerStub = path.join(binDir, "docker");
  writeFileSync(dockerStub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return binDir;
}

describe("resume resolution e2e", () => {
  let home: string;
  let ccairgapHome: string;
  let cleanup: () => Promise<void>;
  let fakeBinDir: string;

  beforeEach(async () => {
    ({ home, ccairgapHome, cleanup } = await mkTmpHome());
    fakeBinDir = await createFakeDockerBinDir();
  });

  afterEach(async () => {
    await cleanup();
    await fs.rm(fakeBinDir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------------------
  // Bad name — no sessions with any custom title
  // ---------------------------------------------------------------------------

  it("--resume with an unknown name exits non-zero with a descriptive message", async () => {
    const repoPath = await seedGitRepo(home, "resume-repo");
    await seedClaudeHome(home);

    const result = await runCli(
      ["--repo", repoPath, "--resume", "nonexistent-session-xyz"],
      {
        env: {
          HOME: home,
          CCAIRGAP_HOME: ccairgapHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).not.toBe(0);
    // The error must be about the resume name, not about docker or credentials
    expect(result.stderr).toMatch(/--resume nonexistent-session-xyz/);
    expect(result.stderr).toMatch(/no session with that name/i);
  });

  // ---------------------------------------------------------------------------
  // Bad UUID — transcript file missing
  // ---------------------------------------------------------------------------

  it("--resume with a UUID that has no transcript exits non-zero", async () => {
    const repoPath = await seedGitRepo(home, "resume-repo");
    await seedClaudeHome(home);

    const missingUuid = "00000000-0000-0000-0000-000000000000";

    const result = await runCli(
      ["--repo", repoPath, "--resume", missingUuid],
      {
        env: {
          HOME: home,
          CCAIRGAP_HOME: ccairgapHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/--resume.*transcript not found/i);
    expect(result.stderr).toContain(missingUuid);
  });

  // ---------------------------------------------------------------------------
  // UUID passthrough — transcript exists, so resume validation passes
  // ---------------------------------------------------------------------------

  it("--resume with a valid UUID reaches post-resume phase when transcript exists", async () => {
    const repoPath = await seedGitRepo(home, "resume-repo");
    await seedClaudeHome(home);

    const uuid = "12345678-abcd-4000-8000-123456789abc";
    const encoded = encodeCwd(repoPath);
    const projectDir = path.join(home, ".claude", "projects", encoded);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, `${uuid}.jsonl`),
      JSON.stringify({ type: "summary", summary: { customTitle: "UUID Test" } }) + "\n",
    );

    const result = await runCli(
      ["--repo", repoPath, "--resume", uuid],
      {
        env: {
          HOME: home,
          CCAIRGAP_HOME: ccairgapHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        },
        cwd: repoPath,
      },
    );

    // The resume validation passed. The CLI will then fail at a later phase
    // (credentials check or image build) — but NOT because of a resume error.
    expect(result.stderr).not.toMatch(/--resume.*transcript not found/i);
    expect(result.stderr).not.toMatch(/no session with that name/i);
    // Exit is non-zero due to a later-phase failure (credentials / docker image)
    // but the specific exit code doesn't matter — we just confirm no resume error.
    expect(result.exitCode).not.toBe(0); // non-zero from a later phase
  });

  // ---------------------------------------------------------------------------
  // Name→UUID scan — transcript with matching customTitle
  // ---------------------------------------------------------------------------

  it("--resume with a custom title resolves to the session and passes resume validation", async () => {
    const repoPath = await seedGitRepo(home, "resume-repo");
    await seedClaudeHome(home);

    const uuid = "aaaabbbb-cccc-4000-8000-ddddeeeeeeee";
    const customTitle = "My Named Test Session";
    const encoded = encodeCwd(repoPath);
    const projectDir = path.join(home, ".claude", "projects", encoded);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, `${uuid}.jsonl`),
      JSON.stringify({ type: "summary", summary: { customTitle } }) + "\n",
    );

    const result = await runCli(
      ["--repo", repoPath, "--resume", customTitle],
      {
        env: {
          HOME: home,
          CCAIRGAP_HOME: ccairgapHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        },
        cwd: repoPath,
      },
    );

    // The name was resolved to a UUID and transcript validated.
    // No resume-specific error should appear.
    expect(result.stderr).not.toMatch(/no session with that name/i);
    expect(result.stderr).not.toMatch(/no sessions have a custom title/i);
    expect(result.stderr).not.toMatch(/--resume.*transcript not found/i);
    // Still non-zero from post-resume phase failure
    expect(result.exitCode).not.toBe(0);
  });

  // ---------------------------------------------------------------------------
  // Case-insensitive name matching
  // ---------------------------------------------------------------------------

  it("--resume name match is case-insensitive", async () => {
    const repoPath = await seedGitRepo(home, "resume-repo");
    await seedClaudeHome(home);

    const uuid = "ccccdddd-eeee-4000-8000-ffffffffffff";
    const customTitle = "Case Sensitive Title";
    const encoded = encodeCwd(repoPath);
    const projectDir = path.join(home, ".claude", "projects", encoded);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      path.join(projectDir, `${uuid}.jsonl`),
      JSON.stringify({ type: "summary", summary: { customTitle } }) + "\n",
    );

    // Search using all-lowercase
    const result = await runCli(
      ["--repo", repoPath, "--resume", "case sensitive title"],
      {
        env: {
          HOME: home,
          CCAIRGAP_HOME: ccairgapHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        },
        cwd: repoPath,
      },
    );

    // Name resolved — no resume error
    expect(result.stderr).not.toMatch(/no session with that name/i);
    expect(result.stderr).not.toMatch(/--resume.*transcript not found/i);
    expect(result.exitCode).not.toBe(0); // later phase failure
  });

  // ---------------------------------------------------------------------------
  // Ambiguous name (multiple sessions with same title)
  // ---------------------------------------------------------------------------

  it("--resume with an ambiguous title exits non-zero listing candidates", async () => {
    const repoPath = await seedGitRepo(home, "resume-repo");
    await seedClaudeHome(home);

    const title = "Shared Title";
    const encoded = encodeCwd(repoPath);
    const projectDir = path.join(home, ".claude", "projects", encoded);
    mkdirSync(projectDir, { recursive: true });

    // Write two transcripts with the same title
    for (const uuid of [
      "11111111-1111-4000-8000-111111111111",
      "22222222-2222-4000-8000-222222222222",
    ]) {
      writeFileSync(
        path.join(projectDir, `${uuid}.jsonl`),
        JSON.stringify({ type: "summary", summary: { customTitle: title } }) + "\n",
      );
    }

    const result = await runCli(
      ["--repo", repoPath, "--resume", title],
      {
        env: {
          HOME: home,
          CCAIRGAP_HOME: ccairgapHome,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ""}`,
        },
        cwd: repoPath,
      },
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/sessions share this name/i);
  });
});
