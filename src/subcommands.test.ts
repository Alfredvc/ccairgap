import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { writeManifest, type Manifest } from "./manifest.js";
import { resolveUserWideDir } from "./userConfig.js";

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
    CODEX_HOME: process.env.CODEX_HOME,
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

describe("doctor: selected agent", () => {
  function stubAllDoctorDeps(runningOutput = ""): void {
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

  it("resolves default, config, and CLI-selected agents", async () => {
    const { resolveSubcommandAgent } = await import("./subcommands.js");

    expect(resolveSubcommandAgent()).toBe("claude");
    expect(resolveSubcommandAgent({ configAgent: "codex" })).toBe("codex");
    expect(resolveSubcommandAgent({ cliAgent: "claude", configAgent: "codex" })).toBe("claude");
  });

  it("emits a Codex doctor credential row without printing auth secrets", async () => {
    const codexHome = join(root, "codex-home");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-secret" }));
    process.env.CODEX_HOME = codexHome;
    stubAllDoctorDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor({ agent: "codex" });
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");

      expect(lines).toContain("[OK] selected agent: codex");
      expect(lines).toContain("[OK] codex credentials: api-key");
      expect(lines).not.toContain("host credentials");
      expect(lines).not.toContain("auth refresh:");
      expect(lines).not.toContain("sk-secret");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("attach", () => {
  it("aborts with a clear message when the container does not exist", async () => {
    // docker inspect exits non-zero when the container is missing.
    stubDocker('echo "Error: No such container: ccairgap-nope" >&2; exit 1');
    const { attach } = await import("./subcommands.js");

    await expect(attach("nope")).rejects.toThrow(/process\.exit\(1\)/);

    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).toContain("no container named ccairgap-nope");
  });

  it("aborts when the container exists but is not running", async () => {
    // First line is `false` → not running. No env follows because the inspect
    // template emits both regardless, but `false\n` alone is enough.
    stubDocker('printf "%s\\n" "false"');
    const { attach } = await import("./subcommands.js");

    await expect(attach("stopped-1234")).rejects.toThrow(/process\.exit\(1\)/);

    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).toContain("not running");
  });

  it("aborts when CCAIRGAP_CWD is missing from Config.Env", async () => {
    // running=true but no CCAIRGAP_CWD in env → not a ccairgap-launched container.
    stubDocker('printf "%s\\n" "true" "PATH=/usr/bin" "FOO=bar"');
    const { attach } = await import("./subcommands.js");

    await expect(attach("foreign-1234")).rejects.toThrow(/process\.exit\(1\)/);

    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).toContain("no CCAIRGAP_CWD");
  });

  it("invokes docker exec with the expected argv shape on a live ccairgap container", async () => {
    // Branch on $1: `inspect` → emit running+env; `exec` → record argv to a
    // file, exit 7 (arbitrary non-zero) so the assertion can also verify exit
    // code propagation without colliding with vitest's own exit handling.
    const argvSink = join(root, "docker-exec-argv.log");
    stubDocker(
      [
        'case "$1" in',
        // inspect: emit `true\nCCAIRGAP_CWD=/workspace/foo\nPATH=/usr/bin`
        '  inspect) printf "%s\\n" "true" "CCAIRGAP_CWD=/workspace/foo" "PATH=/usr/bin" ;;',
        '  exec) printf "%s\\n" "$@" > "' + argvSink + '"; exit 7 ;;',
        "esac",
      ].join("\n"),
    );
    const { attach } = await import("./subcommands.js");

    await expect(attach("live-abcd")).rejects.toThrow(/process\.exit\(7\)/);

    const argv = readFileSync(argvSink, "utf8").trimEnd().split("\n");
    expect(argv[0]).toBe("exec");
    expect(argv).toContain("-it");
    expect(argv).toContain("--user");
    expect(argv).toContain("-w");
    expect(argv[argv.indexOf("-w") + 1]).toBe("/workspace/foo");
    // CCAIRGAP_NAME=<id>#<4hex>
    const nameIdx = argv.findIndex((a) => a.startsWith("CCAIRGAP_NAME="));
    expect(nameIdx).toBeGreaterThan(-1);
    expect(argv[nameIdx]).toMatch(/^CCAIRGAP_NAME=live-abcd#[0-9a-f]{4}$/);
    // Container name + claude entrypoint args trail the docker-exec flags.
    expect(argv).toContain("ccairgap-live-abcd");
    expect(argv).toContain("claude");
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  it("defaults attach to the manifest-selected Codex agent", async () => {
    const sd = join(root, "sessions", "codex-live");
    mkdirSync(sd, { recursive: true });
    writeManifest(sd, {
      version: 1,
      agent: "codex",
      cli_version: "test",
      image_tag: "test:1",
      created_at: new Date().toISOString(),
      repos: [],
      branch: "ccairgap/codex-live",
      codex: { host_home: join(root, "host-codex") },
      claude_code: {},
    });
    const argvSink = join(root, "docker-exec-codex.log");
    stubDocker(
      [
        'case "$1" in',
        '  inspect) printf "%s\\n" "true" "CCAIRGAP_CWD=/workspace/foo" "CODEX_HOME=/home/claude/.codex" ;;',
        '  exec) printf "%s\\n" "$@" > "' + argvSink + '"; exit 0 ;;',
        "esac",
      ].join("\n"),
    );
    const { attach } = await import("./subcommands.js");

    await expect(attach("codex-live")).rejects.toThrow(/process\.exit\(0\)/);

    const argv = readFileSync(argvSink, "utf8").trimEnd().split("\n");
    expect(argv).toContain("codex");
    expect(argv).toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(argv).not.toContain("claude");
  });

  it("treats old manifests without agent as Claude", async () => {
    const argvSink = join(root, "docker-exec-old-manifest.log");
    stubDocker(
      [
        'case "$1" in',
        '  inspect) printf "%s\\n" "true" "CCAIRGAP_CWD=/workspace/foo" ;;',
        '  exec) printf "%s\\n" "$@" > "' + argvSink + '"; exit 0 ;;',
        "esac",
      ].join("\n"),
    );
    const { attach } = await import("./subcommands.js");

    await expect(attach("live-abcd")).rejects.toThrow(/process\.exit\(0\)/);

    const argv = readFileSync(argvSink, "utf8").trimEnd().split("\n");
    expect(argv).toContain("claude");
    expect(argv).toContain("--dangerously-skip-permissions");
  });

  it("allows safe Codex attach passthrough and rejects unsafe Codex flags", async () => {
    const argvSink = join(root, "docker-exec-codex-tail.log");
    stubDocker(
      [
        'case "$1" in',
        '  inspect) printf "%s\\n" "true" "CCAIRGAP_CWD=/workspace/foo" "CODEX_HOME=/home/claude/.codex" ;;',
        '  exec) printf "%s\\n" "$@" > "' + argvSink + '"; exit 0 ;;',
        "esac",
      ].join("\n"),
    );
    const { attach } = await import("./subcommands.js");

    await expect(
      attach("live-abcd", { agent: "codex", selectedAgentArgs: ["--model", "gpt-5"] }),
    ).rejects.toThrow(/process\.exit\(0\)/);
    let argv = readFileSync(argvSink, "utf8").trimEnd().split("\n");
    expect(argv).toContain("--model");
    expect(argv).toContain("gpt-5");

    await expect(
      attach("live-abcd", { agent: "codex", selectedAgentArgs: ["--cd", "/tmp"] }),
    ).rejects.toThrow(/process\.exit\(1\)/);
    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).toContain("Codex passthrough contains denied flag");
  });

  it("validates Claude attach passthrough with the Claude denylist", async () => {
    stubDocker('printf "%s\\n" "true" "CCAIRGAP_CWD=/workspace/foo"');
    const { attach } = await import("./subcommands.js");

    await expect(
      attach("live-abcd", { agent: "claude", selectedAgentArgs: ["--resume", "abc"] }),
    ).rejects.toThrow(/process\.exit\(1\)/);

    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).toContain("claude-args contains a flag ccairgap does not allow");
  });

  it("rejects Codex attach override when Codex state is unavailable in the container", async () => {
    stubDocker('printf "%s\\n" "true" "CCAIRGAP_CWD=/workspace/foo"');
    const { attach } = await import("./subcommands.js");

    await expect(attach("live-abcd", { agent: "codex" })).rejects.toThrow(/process\.exit\(1\)/);

    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).toContain("Codex state is not available");
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

describe("recover dirty-tree precheck", () => {
  // Seed a real host repo + session clone with an uncommitted edit so the
  // pre-scan in `recover` finds dirty state. Without --force this should
  // refuse to delete; with --force it should fall through to handoff (which
  // under noPreserveDirty removes the session).
  function seedDirtySession(id: string): string {
    const hostRepo = join(root, "hostrepo");
    mkdirSync(hostRepo, { recursive: true });
    execaSync("git", ["init", "-q", "-b", "main"], { cwd: hostRepo });
    execaSync("git", ["config", "user.email", "t@t"], { cwd: hostRepo });
    execaSync("git", ["config", "user.name", "t"], { cwd: hostRepo });
    writeFileSync(join(hostRepo, "seed.txt"), "seed\n");
    execaSync("git", ["add", "seed.txt"], { cwd: hostRepo });
    execaSync("git", ["commit", "-qm", "seed"], { cwd: hostRepo });

    const sd = join(root, "sessions", id);
    mkdirSync(join(sd, "repos"), { recursive: true });
    const altName = "hostrepo-deadbeef";
    const sc = join(sd, "repos", altName);
    execaSync("git", ["clone", "--shared", "-q", hostRepo, sc]);
    execaSync("git", ["-C", sc, "checkout", "-q", "-b", `ccairgap/${id}`]);
    writeFileSync(join(sc, "seed.txt"), "edited\n");

    const m: Manifest = {
      version: 1,
      cli_version: "test",
      image_tag: "test:1",
      created_at: new Date().toISOString(),
      repos: [{ basename: "hostrepo", host_path: hostRepo, alternates_name: altName }],
      branch: `ccairgap/${id}`,
      claude_code: {},
    };
    writeManifest(sd, m);
    return sd;
  }

  it("refuses to delete when the session clone has uncommitted changes (no --force)", async () => {
    const id = "dirty-zzzz";
    const sd = seedDirtySession(id);
    stubDocker("exit 0"); // no live container

    const { recover } = await import("./subcommands.js");
    await expect(recover(id)).rejects.toThrow(/process\.exit\(1\)/);

    const stderr = errSpy.mock.calls.map((c) => c[0] as string).join("\n");
    expect(stderr).toContain("uncommitted changes");
    expect(stderr).toContain(`ccairgap recover ${id} --force`);
    expect(existsSync(sd)).toBe(true);
  });

  it("--force discards uncommitted changes and removes the session", async () => {
    const id = "dirty-yyyy";
    const sd = seedDirtySession(id);
    stubDocker("exit 0"); // no live container

    const { recover } = await import("./subcommands.js");
    // handoff may set process.exitCode on warnings but should not throw via exit().
    try {
      await recover(id, { force: true });
    } catch (e) {
      // unexpected — fail loud
      throw e;
    }
    expect(existsSync(sd)).toBe(false);
  });
});

describe("recover Codex rollout handoff", () => {
  it("uses manifest.codex.host_home instead of the current CODEX_HOME", async () => {
    const id = "codex-home";
    const sd = join(root, "sessions", id);
    const manifestHome = join(root, "manifest-codex-home");
    const envHome = join(root, "env-codex-home");
    mkdirSync(join(sd, "codex-sessions", "2026", "05", "13"), { recursive: true });
    mkdirSync(manifestHome, { recursive: true });
    mkdirSync(envHome, { recursive: true });
    writeFileSync(
      join(sd, "codex-sessions", "2026", "05", "13", "rollout-2026-05-13T00-00-00-000Z-abc123.jsonl"),
      "{\"type\":\"session\"}\n",
    );
    writeManifest(sd, {
      version: 1,
      agent: "codex",
      cli_version: "test",
      image_tag: "test:1",
      created_at: new Date().toISOString(),
      repos: [],
      branch: `ccairgap/${id}`,
      codex: { host_home: manifestHome },
      claude_code: {},
    });
    const savedCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = envHome;
    stubDocker("exit 0");

    try {
      const { recover } = await import("./subcommands.js");
      await recover(id);
    } finally {
      if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = savedCodexHome;
    }

    expect(
      existsSync(join(manifestHome, "sessions", "2026", "05", "13", "rollout-2026-05-13T00-00-00-000Z-abc123.jsonl")),
    ).toBe(true);
    expect(existsSync(join(envHome, "sessions"))).toBe(false);
    expect(existsSync(sd)).toBe(false);
  });
});

describe("checkUserWideConfig", () => {
  // The private `checkUserWideConfig` is exercised through the exported `doctor()`
  // aggregate function, following the same pattern as the auth-refresh tests above.
  // We redirect the user-wide dir to a temp location via XDG_CONFIG_HOME so the
  // tests never touch the real ~/.config/ccairgap/.

  let userWideRoot: string;
  let savedXdg: string | undefined;
  let savedHome: string | undefined;

  // Stub docker to pass every doctor check that is unrelated to user-wide config.
  // No running containers → `checkAuthRefresh` returns the "no active sessions" row.
  function stubAllDoctorDeps(): void {
    const script = [
      'case "$1" in',
      '  version) echo "27.0.0" ;;',
      "  ps) : ;;",
      "  image)",
      '    case "$2" in',
      '      inspect) echo "2099-01-01T00:00:00Z" ;;',
      "      ls) : ;;",
      "    esac",
      "    ;;",
      "esac",
    ].join("\n");
    stubDocker(script);
  }

  beforeEach(() => {
    userWideRoot = realpathSync(mkdtempSync(join(tmpdir(), "airgap-uwc-")));
    savedXdg = process.env.XDG_CONFIG_HOME;
    savedHome = process.env.HOME;
    // Point XDG_CONFIG_HOME to our temp dir so resolveUserWideDir resolves to
    // userWideRoot/ccairgap — fully isolated from the developer's real config.
    process.env.XDG_CONFIG_HOME = userWideRoot;
  });

  afterEach(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(userWideRoot, { recursive: true, force: true });
  });

  /** Resolve where checkUserWideConfig will look, mirroring its own logic. */
  function userWideDir(): string {
    return resolveUserWideDir({ env: process.env, home: process.env.HOME ?? userWideRoot });
  }

  it("returns an absent row when user-wide dir does not exist", async () => {
    // userWideRoot/ccairgap is never created — dir is absent.
    stubAllDoctorDeps();
    const dir = userWideDir();
    expect(existsSync(dir)).toBe(false);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(lines).toMatch(new RegExp(`\\[OK\\] user-wide config: .+ \\(absent\\)`));
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reports both policy-bypass and overlay rows when a mix of files are present", async () => {
    const dir = userWideDir();
    mkdirSync(dir, { recursive: true });
    // Write one policy-bypass file and one overlay file plus skills/.
    writeFileSync(join(dir, "settings.json"), "{}");
    writeFileSync(join(dir, "CLAUDE.md"), "# notes");
    mkdirSync(join(dir, "skills"), { recursive: true });

    stubAllDoctorDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");

      // Row A: policy bypass row should appear and mention settings.json.
      expect(lines).toMatch(/\[OK\] user-wide policy bypass:/);
      expect(lines).toMatch(/settings\.json/);
      // Row A must NOT claim bypass framing for overlay-only files.
      const bypassLine = lines.split("\n").find((l) => l.includes("user-wide policy bypass"));
      expect(bypassLine).toBeDefined();
      expect(bypassLine).toMatch(/bypass --hook-enable\/--mcp-enable/);
      expect(bypassLine).not.toMatch(/CLAUDE\.md/);
      expect(bypassLine).not.toMatch(/skills\//);

      // Row B: overlay row should appear and mention CLAUDE.md and skills/.
      expect(lines).toMatch(/\[OK\] user-wide overlay files:/);
      const overlayLine = lines.split("\n").find((l) => l.includes("user-wide overlay files"));
      expect(overlayLine).toBeDefined();
      expect(overlayLine).toMatch(/no policy bypass/);
      expect(overlayLine).toMatch(/CLAUDE\.md/);
      expect(overlayLine).toMatch(/skills\//);
      // Overlay row must NOT mention settings.json.
      expect(overlayLine).not.toMatch(/settings\.json/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits only Row B (overlay) when only overlay files are present", async () => {
    const dir = userWideDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "# notes");

    stubAllDoctorDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");

      expect(lines).toMatch(/\[OK\] user-wide overlay files:/);
      expect(lines).not.toMatch(/user-wide policy bypass/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("emits only Row A (policy bypass) when only bypass files are present", async () => {
    const dir = userWideDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.json"), "{}");

    stubAllDoctorDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");

      expect(lines).toMatch(/\[OK\] user-wide policy bypass:/);
      expect(lines).not.toMatch(/user-wide overlay files/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("reports integrations/*.yaml count as [OK]", async () => {
    const dir = userWideDir();
    const integrationsDir = join(dir, "integrations");
    mkdirSync(integrationsDir, { recursive: true });
    writeFileSync(join(integrationsDir, "work.yaml"), "hooks:\n  enable: []\n");
    writeFileSync(join(integrationsDir, "personal.yaml"), "hooks:\n  enable: []\n");
    // A non-yaml file should not be counted.
    writeFileSync(join(integrationsDir, "notes.txt"), "ignored");

    stubAllDoctorDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(lines).toMatch(/\[OK\] user-wide integrations: 2 file\(s\)/);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("WARNs on <name>.config.yaml files in the user-wide dir", async () => {
    const dir = userWideDir();
    mkdirSync(dir, { recursive: true });
    // This is the reserved-profile pattern: <name>.config.yaml where name != "config".
    writeFileSync(join(dir, "work.config.yaml"), "hooks:\n  enable: []\n");
    // config.yaml itself is allowed and must not trigger the warning.
    writeFileSync(join(dir, "config.yaml"), "");

    stubAllDoctorDeps();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { doctor } = await import("./subcommands.js");
      await doctor();
      const lines = logSpy.mock.calls.map((c) => c[0] as string).join("\n");
      expect(lines).toMatch(/\[WARN\] user-wide reserved profile files:/);
      expect(lines).toMatch(/work\.config\.yaml/);
      // config.yaml itself must not be listed as a reserved file in the warn row.
      // The warn line will contain "work.config.yaml"; assert it is NOT the
      // plain "config.yaml" entry (i.e. no occurrence of "config.yaml" that is
      // not preceded by another word-char, which would indicate the bare name).
      const warnLine = lines
        .split("\n")
        .find((l) => l.includes("user-wide reserved profile files"));
      expect(warnLine).toBeDefined();
      // "config.yaml" preceded by a word boundary (not part of "work.config.yaml")
      // should not appear in the warn line.
      expect(warnLine).not.toMatch(/(?<![A-Za-z0-9._-])config\.yaml/);
    } finally {
      logSpy.mockRestore();
    }
  });
});
