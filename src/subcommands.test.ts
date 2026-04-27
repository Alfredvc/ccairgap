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

describe("doctor: auth-refresh rows", () => {
  // Pin every other doctor check that would otherwise FAIL in this sandbox
  // (no real docker, no creds, no host binaries) to a known shape so the
  // assertions can focus on the auth-refresh row(s) by substring match.
  // The shared `stubDocker` already covers `docker version` / `docker ps` /
  // `docker image inspect` since they all dispatch through the fake binary.
  function stubAllDoctorDeps(runningOutput: string): void {
    // Single fake docker that branches on the first arg.
    // - `docker version --format ...` → emit a version
    // - `docker ps --format ...`     → emit `runningOutput`
    // - `docker image inspect ... --format {{.Created}}` → emit a recent date
    // - `docker image ls ...` → no extra tags
    const script = [
      'case "$1" in',
      '  version) echo "27.0.0" ;;',
      `  ps) printf '%s' '${runningOutput}' ;;`,
      '  image)',
      '    case "$2" in',
      '      inspect) echo "2099-01-01T00:00:00Z" ;;',
      '      ls) : ;;',
      '    esac',
      '    ;;',
      'esac',
    ].join("\n");
    stubDocker(script);
  }

  it('emits "auth refresh: no active sessions" when no session dirs exist', async () => {
    stubAllDoctorDeps("");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(lines).toMatch(/auth refresh: no active sessions/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('emits "auth refresh: no active sessions" when sessions exist but no container is running', async () => {
    const sid = "stale-1234";
    const sd = join(root, "sessions", sid);
    mkdirSync(sd, { recursive: true });
    writeFileSync(
      join(sd, "auth-refresh-state.json"),
      JSON.stringify({
        lastResult: "ok",
        lastClassification: null,
        lastReason: null,
        lastFireMs: Date.now(),
        consecutiveFailures: 0,
        expiresAtMs: Date.now() + 60 * 60_000,
      }),
    );
    stubAllDoctorDeps(""); // no live container
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(lines).toMatch(/auth refresh: no active sessions/);
      expect(lines).not.toMatch(/stale-1234/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits a per-session row reporting last ok status + ttl when the container is running", async () => {
    const sid = "live-9999";
    const sd = join(root, "sessions", sid);
    mkdirSync(sd, { recursive: true });
    writeFileSync(
      join(sd, "auth-refresh-state.json"),
      JSON.stringify({
        lastResult: "ok",
        lastClassification: null,
        lastReason: null,
        lastFireMs: Date.now(),
        consecutiveFailures: 0,
        expiresAtMs: Date.now() + 60 * 60_000,
      }),
    );
    stubAllDoctorDeps(`ccairgap-${sid}`);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(lines).toMatch(new RegExp(`\\[OK\\] auth refresh \\(${sid}\\): last ok`));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('emits "no refresh fired yet" when the live session has no state file', async () => {
    const sid = "fresh-aaaa";
    const sd = join(root, "sessions", sid);
    mkdirSync(sd, { recursive: true });
    // No auth-refresh-state.json written.
    stubAllDoctorDeps(`ccairgap-${sid}`);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(lines).toMatch(new RegExp(`auth refresh \\(${sid}\\): no refresh fired yet`));
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits a FAIL row reporting classification + reason on a failed refresh", async () => {
    const sid = "fail-bbbb";
    const sd = join(root, "sessions", sid);
    mkdirSync(sd, { recursive: true });
    writeFileSync(
      join(sd, "auth-refresh-state.json"),
      JSON.stringify({
        lastResult: "fail",
        lastClassification: "network",
        lastReason: "ETIMEDOUT",
        lastFireMs: Date.now(),
        consecutiveFailures: 1,
        expiresAtMs: Date.now() + 60 * 60_000,
      }),
    );
    stubAllDoctorDeps(`ccairgap-${sid}`);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(lines).toMatch(new RegExp(`auth refresh \\(${sid}\\): last fail \\(network\\): ETIMEDOUT`));
    } finally {
      logSpy.mockRestore();
    }
  });
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
