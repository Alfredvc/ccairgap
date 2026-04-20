import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { execa } from "execa";

export interface TmpHome {
  home: string;          // tmp dir root (used as HOME)
  ccairgapHome: string;  // CCAIRGAP_HOME = home + "/.local/state/ccairgap"
  cleanup: () => Promise<void>;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  sessionId: string | null;  // parsed from CLI output, null if not found
}

const distCliPath = path.resolve(process.cwd(), "dist/cli.js");

/**
 * Session id regex: matches the pattern produced by generateId():
 *   <prefix>-<4hex>
 * where prefix is one or more lowercase-alpha words joined by hyphens.
 * Matches the broader shape described in sessionId.ts: [a-z0-9-]+-[0-9a-f]{4}
 *
 * We extract from combined output by looking for:
 *   "ccairgap recover <id>"  — emitted by handoff failure path
 *   "ccairgap-<id>"          — container name in error messages
 *   "ccairgap/<id>"          — branch name in error messages
 */
const SESSION_ID_RE = /[a-z][a-z0-9-]*-[0-9a-f]{4}(?=[^0-9a-f]|$)/;

function parseSessionId(output: string): string | null {
  // Try to find "ccairgap recover <id>" first (most reliable)
  const recoverMatch = output.match(/ccairgap recover ([a-z][a-z0-9-]*-[0-9a-f]{4})(?:\s|$)/);
  if (recoverMatch?.[1]) return recoverMatch[1];

  // Try to find "ccairgap-<id>" (container name in messages)
  const containerMatch = output.match(/ccairgap-([a-z][a-z0-9-]*-[0-9a-f]{4})(?:\s|$)/);
  if (containerMatch?.[1]) return containerMatch[1];

  // Try to find "ccairgap/<id>" (branch name in messages)
  const branchMatch = output.match(/ccairgap\/([a-z][a-z0-9-]*-[0-9a-f]{4})(?:\s|$)/);
  if (branchMatch?.[1]) return branchMatch[1];

  // Generic fallback: match the session id pattern anywhere
  const genericMatch = output.match(SESSION_ID_RE);
  return genericMatch?.[0] ?? null;
}

/**
 * Create a temporary home directory for an E2E test.
 * CCAIRGAP_HOME is set to $home/.local/state/ccairgap.
 * Call cleanup() when the test is done.
 */
export async function mkTmpHome(): Promise<TmpHome> {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), "ccairgap-e2e-"));
  // macOS tmpdir is a symlink (/var/folders → /private/var/folders). The CLI
  // realpath()s HOME and the workspace repo before building the Claude
  // encoded-cwd transcript path, so tests must seed against the realpath'd
  // form — otherwise seeded files land under the symlink form and the CLI
  // looks under the realpath form. Resolve once up-front.
  const home = await fs.realpath(raw);
  const ccairgapHome = path.join(home, ".local", "state", "ccairgap");
  return {
    home,
    ccairgapHome,
    cleanup: () => fs.rm(raw, { recursive: true, force: true }),
  };
}

/**
 * Seed a git repository under parent/name with optional files.
 * Defaults to { "README.md": "# test" }.
 * Returns the path to the new repo.
 */
export async function seedGitRepo(
  parent: string,
  name: string,
  opts?: { files?: Record<string, string> },
): Promise<string> {
  const repoPath = path.join(parent, name);
  await fs.mkdir(repoPath, { recursive: true });

  await execa("git", ["init", "-q"], { cwd: repoPath });
  await execa("git", ["config", "user.email", "e2e@ccairgap.test"], { cwd: repoPath });
  await execa("git", ["config", "user.name", "ccairgap-e2e"], { cwd: repoPath });

  const files = opts?.files ?? { "README.md": "# test" };
  for (const [filename, content] of Object.entries(files)) {
    const filePath = path.join(repoPath, filename);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content);
  }

  await execa("git", ["add", "."], { cwd: repoPath });
  await execa("git", ["commit", "-m", "init"], { cwd: repoPath });

  return repoPath;
}

/**
 * Seed a minimal ~/.claude directory structure that ccairgap expects.
 * Creates settings.json, projects/, and .claude.json with telemetry disabled.
 */
export async function seedClaudeHome(
  home: string,
  opts?: { settings?: object },
): Promise<void> {
  const claudeDir = path.join(home, ".claude");
  await fs.mkdir(claudeDir, { recursive: true });
  await fs.mkdir(path.join(claudeDir, "projects"), { recursive: true });

  await fs.writeFile(
    path.join(claudeDir, "settings.json"),
    JSON.stringify(opts?.settings ?? {}),
  );

  await fs.writeFile(
    path.join(home, ".claude.json"),
    JSON.stringify({ telemetryEnabled: false }),
  );
}

/**
 * Run the ccairgap CLI (dist/cli.js) via node and capture output.
 * Does NOT throw on non-zero exit. Returns exitCode, stdout, stderr, and
 * a parsed sessionId (null if not found in the output).
 */
export async function runCli(
  args: string[],
  opts?: {
    env?: Record<string, string>;
    cwd?: string;
    timeout?: number;
  },
): Promise<CliResult> {
  const timeout = opts?.timeout ?? 60_000;

  let exitCode = 0;
  let stdout = "";
  let stderr = "";
  let sessionId: string | null = null;

  try {
    const result = await execa("node", [distCliPath, ...args], {
      reject: false,
      env: { ...process.env, ...opts?.env },
      cwd: opts?.cwd ?? process.cwd(),
      timeout,
    });

    exitCode = typeof result.exitCode === "number" ? result.exitCode : 1;
    stdout = result.stdout ?? "";
    stderr = result.stderr ?? "";
    sessionId = parseSessionId(stdout + "\n" + stderr);
  } catch (err: unknown) {
    // Timeout or other spawn error
    const e = err as NodeJS.ErrnoException & {
      timedOut?: boolean;
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    };

    stdout = e.stdout ?? "";
    stderr = e.stderr ?? "";
    sessionId = parseSessionId(stdout + "\n" + stderr);

    if (e.timedOut) {
      // Try to clean up the container if we know the session id, then re-throw
      if (sessionId) {
        try {
          await execa("docker", ["rm", "-f", `ccairgap-${sessionId}`], { reject: false });
        } catch {
          // best-effort
        }
      }
      throw err;
    } else {
      exitCode = e.exitCode ?? 1;
    }
  }

  return { exitCode, stdout, stderr, sessionId };
}

/**
 * Remove any containers whose names match ccairgap-<sessionId>.
 * If sessionId is omitted, removes all containers whose names start with "ccairgap-".
 * Errors are swallowed (best-effort cleanup).
 */
export async function cleanupContainers(sessionId?: string): Promise<void> {
  try {
    const { stdout } = await execa(
      "docker",
      [
        "ps", "-a",
        "--filter", `name=^/ccairgap-${sessionId ?? ""}`,
        "--format", "{{.Names}}",
      ],
      { reject: false },
    );
    const names = stdout.split("\n").filter(Boolean);
    if (names.length === 0) return;
    await execa("docker", ["rm", "-f", ...names], { reject: false });
  } catch {
    // best-effort
  }
}
