import { execa } from "execa";
import { SUPPORTED_CODEX_VERSION, normalizeCodexVersion } from "./image.js";

export interface ImageContractFinding {
  code: string;
  message: string;
}

export interface ImageContractResult {
  ok: boolean;
  findings: ImageContractFinding[];
}

export type ImageContractRunner = (
  args: string[],
) => Promise<{ stdout: string }>;

export interface InspectImageContractOptions {
  run?: ImageContractRunner;
}

const REQUIRED_DIRS = [
  { path: "/home/claude/.claude", code: "missing-claude-home" },
  { path: "/home/claude/.claude/projects", code: "missing-claude-projects" },
  { path: "/home/claude/.codex", code: "missing-codex-home" },
  { path: "/home/claude/.codex/sessions", code: "missing-codex-sessions" },
] as const;

const WRITABLE_DIRS = [
  { path: "/home/claude", code: "home-not-uid-portable" },
  { path: "/home/claude/.claude", code: "claude-home-not-uid-portable" },
  { path: "/home/claude/.codex", code: "codex-home-not-uid-portable" },
] as const;

export async function inspectImageContract(
  tag: string,
  options: InspectImageContractOptions = {},
): Promise<ImageContractResult> {
  const run = options.run ?? dockerRun;
  const findings: ImageContractFinding[] = [];

  await check(run, tag, ["command", "-v", "claude"], findings, {
    code: "missing-claude",
    message: "image does not provide claude on PATH",
  });
  await check(run, tag, ["command", "-v", "codex"], findings, {
    code: "missing-codex",
    message: "image does not provide codex on PATH",
  });

  try {
    const version = await runInImage(run, tag, ["codex", "--version"]);
    const normalized = normalizeCodexVersion(version.stdout);
    if (normalized === undefined) {
      findings.push({
        code: "unparseable-codex-version",
        message: `could not parse image Codex version from: ${version.stdout}`,
      });
    } else if (normalized !== SUPPORTED_CODEX_VERSION) {
      findings.push({
        code: "unsupported-codex-version",
        message:
          `image Codex version ${normalized} is not supported; ` +
          `expected ${SUPPORTED_CODEX_VERSION}`,
      });
    }
  } catch (e) {
    findings.push({
      code: "codex-version-unavailable",
      message: `could not read image Codex version: ${(e as Error).message}`,
    });
  }

  for (const dir of REQUIRED_DIRS) {
    await check(run, tag, ["test", "-d", dir.path], findings, {
      code: dir.code,
      message: `image is missing required directory ${dir.path}`,
    });
  }
  for (const dir of WRITABLE_DIRS) {
    await check(run, tag, ["test", "-w", dir.path], findings, {
      code: dir.code,
      message: `image directory is not writable by runtime UID: ${dir.path}`,
    });
  }

  return { ok: findings.length === 0, findings };
}

async function check(
  run: ImageContractRunner,
  tag: string,
  command: string[],
  findings: ImageContractFinding[],
  finding: ImageContractFinding,
): Promise<void> {
  try {
    await runInImage(run, tag, command);
  } catch {
    findings.push(finding);
  }
}

function runInImage(
  run: ImageContractRunner,
  tag: string,
  command: string[],
): Promise<{ stdout: string }> {
  return run(["run", "--rm", "--entrypoint", "sh", tag, "-lc", command.join(" ")]);
}

async function dockerRun(args: string[]): Promise<{ stdout: string }> {
  const result = await execa("docker", args);
  return { stdout: result.stdout };
}
