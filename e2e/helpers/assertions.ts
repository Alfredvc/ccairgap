import { expect } from "vitest";
import { execa } from "execa";
import * as fs from "fs/promises";
import * as path from "path";

/**
 * Assert that at least one branch in the repository at repoPath matches
 * the given pattern. Uses `git branch -a` to enumerate all local and
 * remote-tracking branches.
 */
export async function assertBranchExists(repoPath: string, pattern: RegExp): Promise<void> {
  const { stdout } = await execa("git", ["branch", "-a"], { cwd: repoPath });
  const branches = stdout
    .split("\n")
    .map((line) => line.replace(/^\*?\s+/, "").trim())
    .filter(Boolean);
  const found = branches.some((b) => pattern.test(b));
  expect(found, `Expected a branch matching ${pattern} in ${repoPath}. Branches: ${branches.join(", ")}`).toBe(true);
}

/**
 * Assert that the session directory for the given sessionId has been
 * removed (i.e., does not exist under ccairgapHome/sessions/).
 * Skips the assertion if sessionId is null.
 */
export async function assertSessionDirRemoved(
  ccairgapHome: string,
  sessionId: string | null,
): Promise<void> {
  if (sessionId === null) return;
  const sessionDir = path.join(ccairgapHome, "sessions", sessionId);
  let exists = false;
  try {
    await fs.access(sessionDir);
    exists = true;
  } catch {
    exists = false;
  }
  expect(exists, `Expected session dir to be removed: ${sessionDir}`).toBe(false);
}

/**
 * Build --docker-run-arg flags to pass a test command into the container
 * via the CCAIRGAP_TEST_CMD environment variable.
 *
 * The script must be single-quoted so `parseDockerRunArgs` (shell-quote) keeps
 * it as a single literal token. Without quoting, a script like `exit 0` would
 * split into ["exit", "0"] and the stray `0` token corrupts the docker arg
 * layout. Raw single quotes inside the script are rejected — the helper is
 * intended for shell-free literal commands only.
 */
export function testCmd(script: string): string[] {
  if (script.includes("'")) {
    throw new Error("testCmd: script must not contain single quotes");
  }
  return ["--docker-run-arg=-e", `--docker-run-arg=CCAIRGAP_TEST_CMD='${script}'`];
}

/**
 * Assert that a file exists at the given path.
 */
export async function assertFileExists(filePath: string): Promise<void> {
  let exists = false;
  try {
    await fs.access(filePath);
    exists = true;
  } catch {
    exists = false;
  }
  expect(exists, `Expected file to exist: ${filePath}`).toBe(true);
}

/**
 * Assert that a file's content matches a string or regular expression.
 */
export async function assertFileContains(filePath: string, pattern: string | RegExp): Promise<void> {
  const content = await fs.readFile(filePath, "utf8");
  if (typeof pattern === "string") {
    expect(content, `Expected file ${filePath} to contain: ${pattern}`).toContain(pattern);
  } else {
    expect(content, `Expected file ${filePath} to match: ${pattern}`).toMatch(pattern);
  }
}
