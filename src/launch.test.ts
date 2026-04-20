import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { launch, validateRepoRoOverlap } from "./launch.js";
import { encodeCwd } from "./paths.js";

const fakeRealpath = (map: Record<string, string>) => (p: string) => {
  if (!(p in map)) {
    const err = new Error(`ENOENT: no such file or directory, realpath '${p}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  return map[p]!;
};

describe("validateRepoRoOverlap (unit)", () => {
  it("accepts disjoint repo and ro sets", () => {
    const rp = fakeRealpath({ "/a": "/a", "/b": "/b", "/c": "/c" });
    expect(() => validateRepoRoOverlap(["/a", "/b"], ["/c"], rp)).not.toThrow();
  });

  it("errors on identical repo paths", () => {
    const rp = fakeRealpath({ "/a": "/a" });
    expect(() => validateRepoRoOverlap(["/a", "/a"], [], rp)).toThrow(/duplicate repo path/);
  });

  it("errors when two symlinked repo paths resolve to the same real path", () => {
    const rp = fakeRealpath({ "/sym1": "/real", "/sym2": "/real" });
    expect(() => validateRepoRoOverlap(["/sym1", "/sym2"], [], rp)).toThrow(
      /duplicate repo path/,
    );
  });

  it("errors when --ro is a symlink pointing at a repo real path", () => {
    const rp = fakeRealpath({ "/sym": "/real", "/real": "/real" });
    expect(() => validateRepoRoOverlap(["/sym"], ["/real"], rp)).toThrow(
      /appears in both repo .* and --ro/,
    );
  });

  it("errors when --repo is a symlink pointing at a --ro real path", () => {
    const rp = fakeRealpath({ "/sym": "/real", "/real": "/real" });
    expect(() => validateRepoRoOverlap(["/sym"], ["/real"], rp)).toThrow(
      /appears in both repo .* and --ro/,
    );
  });

  it("errors cleanly on nonexistent --repo path (preserves UX)", () => {
    const rp = fakeRealpath({});
    expect(() => validateRepoRoOverlap(["/typo"], [], rp)).toThrow(
      /--repo\/--extra-repo path does not exist: \/typo/,
    );
  });

  it("errors cleanly on nonexistent --ro path (preserves UX)", () => {
    const rp = fakeRealpath({ "/a": "/a" });
    expect(() => validateRepoRoOverlap(["/a"], ["/nope"], rp)).toThrow(
      /--ro path does not exist: \/nope/,
    );
  });
});

describe("validateRepoRoOverlap (integration with real fs)", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-overlap-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a symlinked --ro that points at a real --repo path", () => {
    const real = join(root, "realrepo");
    mkdirSync(real, { recursive: true });
    const sym = join(root, "sym");
    symlinkSync(real, sym);
    expect(() => validateRepoRoOverlap([real], [sym], realpathSync)).toThrow(
      /appears in both repo .* and --ro/,
    );
  });

  it("catches a symlinked --repo whose target equals another --repo", () => {
    const real = join(root, "r");
    mkdirSync(real, { recursive: true });
    const sym = join(root, "s");
    symlinkSync(real, sym);
    expect(() => validateRepoRoOverlap([real, sym], [], realpathSync)).toThrow(
      /duplicate repo path/,
    );
  });
});

/**
 * Locks in the load-bearing invariant from CLAUDE.md: `--resume` validation
 * runs in the validation phase before `mkdirSync($SESSION)`. A bogus uuid
 * with no matching transcript on the host must exit 1 with no session dir
 * left on disk.
 */
describe("launch --resume validation runs before any session-dir creation", () => {
  let root: string;
  let ccairgapHome: string;
  let fakeHome: string;
  let repoDir: string;
  let fakeBinDir: string;
  let savedEnv: Record<string, string | undefined>;
  let exitSpy: MockInstance<(code?: string | number | null | undefined) => never>;
  let stderrSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-resume-validate-")));
    ccairgapHome = join(root, "state");
    fakeHome = join(root, "home");
    repoDir = join(root, "repo");
    fakeBinDir = join(root, "bin");
    mkdirSync(ccairgapHome, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    // Empty projects/<encoded>/ — no <uuid>.jsonl present.
    const encoded = encodeCwd(repoDir);
    mkdirSync(join(fakeHome, ".claude", "projects", encoded), { recursive: true });
    // Fake host repo with a real .git so resolveGitDir succeeds.
    mkdirSync(repoDir, { recursive: true });
    execaSync("git", ["init", "-q"], { cwd: repoDir });
    // Stub `docker` (and re-stub git/rsync/cp via the real PATH) so
    // requireHostBinaries' `command -v docker` succeeds without a real daemon.
    // Resume validation aborts long before the docker run ever happens.
    mkdirSync(fakeBinDir, { recursive: true });
    const dockerStub = join(fakeBinDir, "docker");
    writeFileSync(dockerStub, "#!/bin/sh\nexit 0\n");
    chmodSync(dockerStub, 0o755);

    savedEnv = {
      CCAIRGAP_HOME: process.env.CCAIRGAP_HOME,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    };
    process.env.CCAIRGAP_HOME = ccairgapHome;
    process.env.HOME = fakeHome;
    process.env.PATH = `${fakeBinDir}:${savedEnv.PATH ?? ""}`;

    // launch() calls die() which calls process.exit(1). Convert to a throw so
    // the test can assert on it without killing the vitest process.
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it("errors with the spec message and creates no $SESSION dir", async () => {
    const bogusUuid = "00000000-0000-0000-0000-000000000000";
    const expectedJsonl = join(
      fakeHome,
      ".claude",
      "projects",
      encodeCwd(repoDir),
      `${bogusUuid}.jsonl`,
    );

    await expect(
      launch({
        repos: [repoDir],
        ros: [],
        cp: [],
        sync: [],
        mount: [],
        keepContainer: false,
        dockerBuildArgs: {},
        rebuild: false,
        hookEnable: [],
        mcpEnable: [],
        dockerRunArgs: [],
        warnDockerArgs: false,
        bare: false,
        clipboard: false,
        noPreserveDirty: false,
        refreshBelowTtlMinutes: 0,
        resume: bogusUuid,
      }),
    ).rejects.toThrow(/process\.exit\(1\)/);

    // The exact spec error message landed in stderr (via die()).
    const stderrLines = stderrSpy.mock.calls.map((args) => String(args[0]));
    expect(stderrLines.some((l) => l.includes(`--resume ${bogusUuid}: transcript not found at ${expectedJsonl}`))).toBe(true);

    // No session dir was created — sessions/ should be empty (or not exist).
    const sessionsRoot = join(ccairgapHome, "sessions");
    if (existsSync(sessionsRoot)) {
      expect(readdirSync(sessionsRoot)).toEqual([]);
    }
  });
});

/**
 * Locks in the unified-id naming contract:
 *   - `CCAIRGAP_NAME` is always set on `docker run`, and its value equals the
 *     session id (NOT the raw --name prefix).
 *   - `CCAIRGAP_RESUME_ORIG_NAME` is never emitted.
 * Entrypoint-level behavior (`-n "ccairgap $CCAIRGAP_NAME"` / hook title
 * `[ccairgap] $CCAIRGAP_NAME`) is covered by the entrypoint test below; this
 * suite only asserts what the CLI hands to docker.
 */
describe("launch emits CCAIRGAP_NAME=<id> on docker run", () => {
  let root: string;
  let ccairgapHome: string;
  let fakeHome: string;
  let repoDir: string;
  let fakeBinDir: string;
  let dockerLog: string;
  let savedEnv: Record<string, string | undefined>;
  let stderrSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-name-emit-")));
    ccairgapHome = join(root, "state");
    fakeHome = join(root, "home");
    repoDir = join(root, "repo");
    fakeBinDir = join(root, "bin");
    dockerLog = join(root, "docker.log");
    mkdirSync(ccairgapHome, { recursive: true });
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    execaSync("git", ["init", "-q"], { cwd: repoDir });
    execaSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repoDir });

    // Fake docker: logs each invocation's argv (space-joined) to $dockerLog,
    // exits 0 so `image inspect` says "exists" and `docker run` says "container
    // exited cleanly". Keeps the launch pipeline advancing through arg-assembly
    // without a real daemon.
    mkdirSync(fakeBinDir, { recursive: true });
    const dockerStub = join(fakeBinDir, "docker");
    writeFileSync(
      dockerStub,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${dockerLog}"
exit 0
`,
    );
    chmodSync(dockerStub, 0o755);

    // Credentials: stub macOS `security` to emit a minimal valid JSON blob;
    // also create ~/.claude/.credentials.json so Linux code path works.
    const securityStub = join(fakeBinDir, "security");
    writeFileSync(
      securityStub,
      `#!/bin/sh
printf '%s' '{"claudeAiOauth":{"accessToken":"fake"}}'
exit 0
`,
    );
    chmodSync(securityStub, 0o755);
    writeFileSync(join(fakeHome, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"fake"}}');
    // Minimal host `~/.claude.json` — launch.ts realpath()s it unconditionally.
    writeFileSync(join(fakeHome, ".claude.json"), "{}");

    savedEnv = {
      CCAIRGAP_HOME: process.env.CCAIRGAP_HOME,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
    };
    process.env.CCAIRGAP_HOME = ccairgapHome;
    process.env.HOME = fakeHome;
    process.env.PATH = `${fakeBinDir}:${savedEnv.PATH ?? ""}`;

    stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  /** Return the one `docker run …` line logged by the stub. Fails the test if absent. */
  function dockerRunLine(): string {
    const lines = readFileSync(dockerLog, "utf8").split("\n").filter(Boolean);
    const run = lines.find((l) => l.startsWith("run "));
    if (run === undefined) {
      throw new Error(`no 'docker run …' invocation recorded. Log:\n${lines.join("\n")}`);
    }
    return run;
  }

  it("fresh session (no --name): CCAIRGAP_NAME = <adj>-<noun>-<4hex>", async () => {
    const result = await launch({
      repos: [repoDir],
      ros: [],
      cp: [],
      sync: [],
      mount: [],
      keepContainer: false,
      dockerBuildArgs: {},
      rebuild: false,
      hookEnable: [],
      mcpEnable: [],
      dockerRunArgs: [],
      warnDockerArgs: false,
      bare: false,
      clipboard: false,
      noPreserveDirty: false,
        refreshBelowTtlMinutes: 0,
    });
    expect(result.id).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    const run = dockerRunLine();
    expect(run).toContain(`-e CCAIRGAP_NAME=${result.id}`);
    expect(run).not.toContain("CCAIRGAP_RESUME_ORIG_NAME");
  });

  it("explicit --name: CCAIRGAP_NAME = <name>-<4hex> (never the raw prefix)", async () => {
    const result = await launch({
      repos: [repoDir],
      ros: [],
      cp: [],
      sync: [],
      mount: [],
      keepContainer: false,
      dockerBuildArgs: {},
      rebuild: false,
      hookEnable: [],
      mcpEnable: [],
      dockerRunArgs: [],
      warnDockerArgs: false,
      bare: false,
      clipboard: false,
      noPreserveDirty: false,
        refreshBelowTtlMinutes: 0,
      name: "myfeature",
    });
    expect(result.id).toMatch(/^myfeature-[0-9a-f]{4}$/);
    const run = dockerRunLine();
    expect(run).toContain(`-e CCAIRGAP_NAME=${result.id}`);
    expect(run).not.toContain("-e CCAIRGAP_NAME=myfeature ");
    expect(run).not.toContain("CCAIRGAP_RESUME_ORIG_NAME");
  });

  it("resume: CCAIRGAP_NAME = new id; no CCAIRGAP_RESUME_ORIG_NAME even when source jsonl has agent-name", async () => {
    const uuid = "00000000-0000-0000-0000-000000000001";
    const encoded = encodeCwd(repoDir);
    mkdirSync(join(fakeHome, ".claude", "projects", encoded), { recursive: true });
    writeFileSync(
      join(fakeHome, ".claude", "projects", encoded, `${uuid}.jsonl`),
      [
        '{"type":"user","message":{"content":"hi"}}',
        '{"type":"agent-name","agentName":"priorname"}',
      ].join("\n") + "\n",
    );

    const result = await launch({
      repos: [repoDir],
      ros: [],
      cp: [],
      sync: [],
      mount: [],
      keepContainer: false,
      dockerBuildArgs: {},
      rebuild: false,
      hookEnable: [],
      mcpEnable: [],
      dockerRunArgs: [],
      warnDockerArgs: false,
      bare: false,
      clipboard: false,
      noPreserveDirty: false,
        refreshBelowTtlMinutes: 0,
      resume: uuid,
    });
    const run = dockerRunLine();
    expect(run).toContain(`-e CCAIRGAP_NAME=${result.id}`);
    expect(run).toContain(`-e CCAIRGAP_RESUME=${uuid}`);
    expect(run).not.toContain("CCAIRGAP_RESUME_ORIG_NAME");
    expect(run).not.toContain("priorname");
  });
});
