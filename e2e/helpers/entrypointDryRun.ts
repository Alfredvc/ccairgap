import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { execa } from "execa";

const FAKE_DOCKERFILE = "e2e/fixtures/fake.Dockerfile";

export interface EntrypointDryRunOptions {
  agent: "claude" | "codex";
  print?: string;
  cwd?: string;
  argv?: string[];
}

export async function runEntrypointDryRun(
  options: EntrypointDryRunOptions,
): Promise<string> {
  const tag = fakeImageTag();
  await execa("docker", [
    "build",
    "-t",
    tag,
    "-f",
    FAKE_DOCKERFILE,
    dirname(FAKE_DOCKERFILE),
  ]);

  const dockerArgs = [
    "run",
    "--rm",
    "-e",
    "CCAIRGAP_ENTRYPOINT_DRY_RUN=1",
    "-e",
    `CCAIRGAP_AGENT=${options.agent}`,
    "-e",
    `CCAIRGAP_CWD=${options.cwd ?? "/workspace/repo with spaces"}`,
  ];
  if (options.print !== undefined) {
    dockerArgs.push("-e", `CCAIRGAP_PRINT=${options.print}`);
  }
  dockerArgs.push(tag, ...(options.argv ?? []));

  const result = await execa("docker", dockerArgs);
  return result.stdout;
}

function fakeImageTag(): string {
  const content = readFileSync(resolve(FAKE_DOCKERFILE));
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `ccairgap:entrypoint-dry-run-${hash}`;
}
