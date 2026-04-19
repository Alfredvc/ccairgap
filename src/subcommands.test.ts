import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeManifest, type Manifest } from "./manifest.js";

let root: string;
let fakeBinDir: string;
let savedEnv: Record<string, string | undefined>;
let exitSpy: MockInstance<(code?: string | number | null | undefined) => never>;
let errSpy: MockInstance<(...args: unknown[]) => void>;

function stubDocker(script: string): void {
  const p = join(fakeBinDir, "docker");
  writeFileSync(p, `#!/bin/sh\n${script}\n`);
  chmodSync(p, 0o755);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-subcmd-")));
  fakeBinDir = join(root, "bin");
  mkdirSync(fakeBinDir, { recursive: true });
  savedEnv = {
    CCAIRGAP_HOME: process.env.CCAIRGAP_HOME,
    PATH: process.env.PATH,
  };
  process.env.CCAIRGAP_HOME = root;
  process.env.PATH = `${fakeBinDir}:${savedEnv.PATH ?? ""}`;

  // Seed a minimal session dir so recover() gets past its existsSync check.
  const sd = join(root, "sessions", "live-abcd");
  mkdirSync(join(sd, "repos"), { recursive: true });
  const m: Manifest = {
    version: 1,
    cli_version: "test",
    image_tag: "test:1",
    created_at: new Date().toISOString(),
    repos: [],
    branch: "ccairgap/live-abcd",
    claude_code: {},
  };
  writeManifest(sd, m);

  // Convert process.exit to throw so the test can assert without killing vitest.
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  exitSpy.mockRestore();
  errSpy.mockRestore();
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe("recover live-container precheck", () => {
  it("aborts with a clear message when the container is running", async () => {
    // Shared helper prints all running container names; emit ours.
    stubDocker('echo "ccairgap-live-abcd"');
    const { recover } = await import("./subcommands.js");

    await expect(recover("live-abcd")).rejects.toThrow(/process\.exit\(1\)/);

    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).toContain("ccairgap-live-abcd");
    expect(stderr).toContain("docker stop");
  });

  it("proceeds when no container is running (empty docker ps output)", async () => {
    stubDocker("exit 0"); // empty stdout → no running container
    const { recover } = await import("./subcommands.js");

    try {
      await recover("live-abcd");
    } catch {
      // handoff may warn or trigger exit(1) via process.exitCode; we only
      // care that the *precheck*-specific stderr line is NOT present.
    }
    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).not.toContain("docker stop ccairgap-live-abcd");
  });

  it("ignores unrelated container names", async () => {
    // printf %s\\n ... ensures portable newline handling across /bin/sh
    // variants (dash does not interpret \\n inside echo).
    stubDocker("printf '%s\\n' 'ccairgap-other-1234' 'some-other-container'");
    const { recover } = await import("./subcommands.js");

    // precheck should pass — no `ccairgap-live-abcd` in the list.
    try {
      await recover("live-abcd");
    } catch {
      // handoff may warn; we don't care here.
    }
    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).not.toContain("docker stop ccairgap-live-abcd");
  });
});
