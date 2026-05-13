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
import { sanitizePath } from "./autoMemory.js";

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
        claudeArgs: [],
        noAutoMemory: false,
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
      claudeArgs: [],
      noAutoMemory: false,
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
      noAutoMemory: false,
      refreshBelowTtlMinutes: 0,
      name: "myfeature",
      claudeArgs: [],
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
      noAutoMemory: false,
      refreshBelowTtlMinutes: 0,
      resume: uuid,
      claudeArgs: [],
    });
    const run = dockerRunLine();
    expect(run).toContain(`-e CCAIRGAP_NAME=${result.id}`);
    expect(run).toContain(`-e CCAIRGAP_RESUME=${uuid}`);
    expect(run).not.toContain("CCAIRGAP_RESUME_ORIG_NAME");
    expect(run).not.toContain("priorname");
  });

  it("mounts auto-memory dir at /host-claude-memory and sets CLAUDE_COWORK_MEMORY_PATH_OVERRIDE", async () => {
    const repoReal = realpathSync(repoDir);
    const memoryDir = join(fakeHome, ".claude", "projects", sanitizePath(repoReal), "memory");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# seed\n");

    await launch({
      repos: [repoDir], ros: [], cp: [], sync: [], mount: [],
      keepContainer: false, dockerBuildArgs: {}, rebuild: false,
      hookEnable: [], mcpEnable: [], dockerRunArgs: [], warnDockerArgs: false,
      bare: false, clipboard: false, noPreserveDirty: false, noAutoMemory: false, claudeArgs: [], refreshBelowTtlMinutes: 0,
    });

    const run = dockerRunLine();
    expect(run).toContain(`-v ${memoryDir}:/host-claude-memory:ro`);
    expect(run).toContain("-e CLAUDE_COWORK_MEMORY_PATH_OVERRIDE=/host-claude-memory");
  });

  it("skips auto-memory when --no-auto-memory is set", async () => {
    const repoReal = realpathSync(repoDir);
    const memoryDir = join(fakeHome, ".claude", "projects", sanitizePath(repoReal), "memory");
    mkdirSync(memoryDir, { recursive: true });

    await launch({
      repos: [repoDir], ros: [], cp: [], sync: [], mount: [],
      keepContainer: false, dockerBuildArgs: {}, rebuild: false,
      hookEnable: [], mcpEnable: [], dockerRunArgs: [], warnDockerArgs: false,
      bare: false, clipboard: false, noPreserveDirty: false, noAutoMemory: true, claudeArgs: [], refreshBelowTtlMinutes: 0,
    });

    const run = dockerRunLine();
    expect(run).not.toContain("/host-claude-memory");
    expect(run).not.toContain("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE");
  });

  it("does not emit the mount or env var when the host memory dir is absent", async () => {
    await launch({
      repos: [repoDir], ros: [], cp: [], sync: [], mount: [],
      keepContainer: false, dockerBuildArgs: {}, rebuild: false,
      hookEnable: [], mcpEnable: [], dockerRunArgs: [], warnDockerArgs: false,
      bare: false, clipboard: false, noPreserveDirty: false, noAutoMemory: false, claudeArgs: [], refreshBelowTtlMinutes: 0,
    });
    const run = dockerRunLine();
    expect(run).not.toContain("/host-claude-memory");
    expect(run).not.toContain("CLAUDE_COWORK_MEMORY_PATH_OVERRIDE");
  });

  it("forwards NODE_EXTRA_CA_CERTS into the container via neutral /host-ca-certs mount", async () => {
    const caFile = join(fakeHome, "corp-ca.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----\n");
    process.env.NODE_EXTRA_CA_CERTS = caFile;
    try {
      await launch({
        repos: [repoDir], ros: [], cp: [], sync: [], mount: [],
        keepContainer: false, dockerBuildArgs: {}, rebuild: false,
        hookEnable: [], mcpEnable: [], dockerRunArgs: [], warnDockerArgs: false,
        bare: false, clipboard: false, noPreserveDirty: false, noAutoMemory: false, claudeArgs: [], refreshBelowTtlMinutes: 0,
      });
    } finally {
      delete process.env.NODE_EXTRA_CA_CERTS;
    }

    const run = dockerRunLine();
    const real = realpathSync(caFile);
    expect(run).toContain(`-e NODE_EXTRA_CA_CERTS=/host-ca-certs/corp-ca.pem`);
    expect(run).toContain(`-v ${real}:/host-ca-certs/corp-ca.pem:ro`);
  });

  it("does not forward NODE_EXTRA_CA_CERTS when the file is missing", async () => {
    process.env.NODE_EXTRA_CA_CERTS = join(fakeHome, "does-not-exist.pem");
    try {
      await launch({
        repos: [repoDir], ros: [], cp: [], sync: [], mount: [],
        keepContainer: false, dockerBuildArgs: {}, rebuild: false,
        hookEnable: [], mcpEnable: [], dockerRunArgs: [], warnDockerArgs: false,
        bare: false, clipboard: false, noPreserveDirty: false, noAutoMemory: false, claudeArgs: [], refreshBelowTtlMinutes: 0,
      });
    } finally {
      delete process.env.NODE_EXTRA_CA_CERTS;
    }
    const run = dockerRunLine();
    expect(run).not.toContain("NODE_EXTRA_CA_CERTS");
  });

  it("rejects NODE_EXTRA_CA_CERTS whose basename contains ':' (breaks docker -v parsing)", async () => {
    const caFile = join(fakeHome, "weird:name.pem");
    writeFileSync(caFile, "-----BEGIN CERTIFICATE-----\n");
    process.env.NODE_EXTRA_CA_CERTS = caFile;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    try {
      await expect(
        launch({
          repos: [repoDir], ros: [], cp: [], sync: [], mount: [],
          keepContainer: false, dockerBuildArgs: {}, rebuild: false,
          hookEnable: [], mcpEnable: [], dockerRunArgs: [], warnDockerArgs: false,
          bare: false, clipboard: false, noPreserveDirty: false, noAutoMemory: false, claudeArgs: [], refreshBelowTtlMinutes: 0,
        }),
      ).rejects.toThrow(/process\.exit\(1\)/);
    } finally {
      delete process.env.NODE_EXTRA_CA_CERTS;
      exitSpy.mockRestore();
    }
  });

  it("resolves symlinked NODE_EXTRA_CA_CERTS via realpath (container path uses the real basename)", async () => {
    const realFile = join(fakeHome, "real-ca.pem");
    const symLink = join(fakeHome, "ca-link.pem");
    writeFileSync(realFile, "-----BEGIN CERTIFICATE-----\n");
    symlinkSync(realFile, symLink);
    process.env.NODE_EXTRA_CA_CERTS = symLink;
    try {
      await launch({
        repos: [repoDir], ros: [], cp: [], sync: [], mount: [],
        keepContainer: false, dockerBuildArgs: {}, rebuild: false,
        hookEnable: [], mcpEnable: [], dockerRunArgs: [], warnDockerArgs: false,
        bare: false, clipboard: false, noPreserveDirty: false, noAutoMemory: false, claudeArgs: [], refreshBelowTtlMinutes: 0,
      });
    } finally {
      delete process.env.NODE_EXTRA_CA_CERTS;
    }
    const run = dockerRunLine();
    const real = realpathSync(realFile);
    expect(run).toContain(`-e NODE_EXTRA_CA_CERTS=/host-ca-certs/real-ca.pem`);
    expect(run).toContain(`-v ${real}:/host-ca-certs/real-ca.pem:ro`);
  });
});

describe("launch agent=codex runtime enablement", () => {
  let root: string;
  let ccairgapHome: string;
  let fakeHome: string;
  let repoDir: string;
  let roDir: string;
  let fakeBinDir: string;
  let dockerLog: string;
  let savedEnv: Record<string, string | undefined>;
  let exitSpy: MockInstance<(code?: string | number | null | undefined) => never>;
  let stderrSpy: MockInstance<(...args: unknown[]) => void>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-codex-runtime-")));
    ccairgapHome = join(root, "state");
    fakeHome = join(root, "home");
    repoDir = join(root, "repo");
    roDir = join(root, "readonly");
    fakeBinDir = join(root, "bin");
    dockerLog = join(root, "docker.log");
    mkdirSync(ccairgapHome, { recursive: true });
    mkdirSync(join(fakeHome, ".claude"), { recursive: true });
    mkdirSync(join(fakeHome, ".codex"), { recursive: true });
    mkdirSync(repoDir, { recursive: true });
    mkdirSync(roDir, { recursive: true });
    execaSync("git", ["init", "-q"], { cwd: repoDir });
    execaSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repoDir });
    writeFileSync(join(fakeHome, ".claude.json"), "{}");
    writeFileSync(join(fakeHome, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"fake"}}');
    writeFileSync(join(fakeHome, ".codex", "auth.json"), '{"OPENAI_API_KEY":"sk-test"}');

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

    savedEnv = {
      CCAIRGAP_HOME: process.env.CCAIRGAP_HOME,
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      CODEX_HOME: process.env.CODEX_HOME,
      CODEX_API_KEY: process.env.CODEX_API_KEY,
    };
    process.env.CCAIRGAP_HOME = ccairgapHome;
    process.env.HOME = fakeHome;
    process.env.PATH = `${fakeBinDir}:${savedEnv.PATH ?? ""}`;
    delete process.env.CODEX_HOME;
    delete process.env.CODEX_API_KEY;

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
    vi.doUnmock("./binaries.js");
    vi.doUnmock("./sessionId.js");
    vi.doUnmock("./credentials.js");
    vi.doUnmock("./orphans.js");
    vi.doUnmock("./image.js");
    vi.doUnmock("./imageContract.js");
    vi.doUnmock("./runtimeAuthRefresh.js");
    vi.doUnmock("./handoff.js");
    rmSync(root, { recursive: true, force: true });
  });

  function baseOptions(overrides: Partial<Parameters<typeof launch>[0]> = {}): Parameters<typeof launch>[0] {
    return {
      agent: "codex",
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
      claudeArgs: [],
      codexArgs: [],
      noAutoMemory: true,
      refreshBelowTtlMinutes: 0,
      ...overrides,
    };
  }

  async function importLaunchWithMocks(options: {
    generateId?: ReturnType<typeof vi.fn>;
    resolveCredentials?: ReturnType<typeof vi.fn>;
    startRuntimeAuthRefresh?: ReturnType<typeof vi.fn>;
    ensureImage?: ReturnType<typeof vi.fn>;
    inspectImageContract?: ReturnType<typeof vi.fn>;
  } = {}) {
    await vi.resetModules();
    const generateId = options.generateId ?? vi.fn(async () => ({ id: "codex-0001" }));
    const resolveCredentials = options.resolveCredentials ?? vi.fn(async () => {
      throw new Error("selected Codex should not refresh Claude credentials");
    });
    const startRuntimeAuthRefresh =
      options.startRuntimeAuthRefresh ??
      vi.fn(() => ({
        stop: vi.fn(async () => {}),
      }));
    const ensureImage =
      options.ensureImage ??
      vi.fn(async () => ({
        tag: "ccairgap:test",
        contextDir: root,
        dockerfile: join(root, "Dockerfile"),
      }));
    const inspectImageContract =
      options.inspectImageContract ?? vi.fn(async () => ({ ok: true, findings: [] }));

    vi.doMock("./binaries.js", () => ({
      requireHostBinaries: vi.fn(async () => {}),
    }));
    vi.doMock("./sessionId.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./sessionId.js")>()),
      generateId,
      listAllContainerNames: vi.fn(async () => []),
    }));
    vi.doMock("./credentials.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./credentials.js")>()),
      resolveCredentials,
    }));
    vi.doMock("./orphans.js", () => ({ scanOrphans: vi.fn(async () => []) }));
    vi.doMock("./image.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./image.js")>()),
      defaultDockerfile: vi.fn(() => join(root, "Dockerfile")),
      ensureImage,
      hostClaudeVersion: vi.fn(async () => "1.0.0"),
    }));
    vi.doMock("./imageContract.js", () => ({
      inspectImageContract,
    }));
    vi.doMock("./runtimeAuthRefresh.js", () => ({
      startRuntimeAuthRefresh,
    }));
    vi.doMock("./handoff.js", () => ({ handoff: vi.fn(async () => {}) }));

    const mod = await import("./launch.js");
    return {
      launch: mod.launch,
      generateId,
      resolveCredentials,
      startRuntimeAuthRefresh,
      ensureImage,
      inspectImageContract,
    };
  }

  function sessionEntries(): string[] {
    const sessionsRoot = join(ccairgapHome, "sessions");
    return existsSync(sessionsRoot) ? readdirSync(sessionsRoot) : [];
  }

  function dockerRunLine(): string {
    const lines = readFileSync(dockerLog, "utf8").split("\n").filter(Boolean);
    const run = lines.find((line) => line.startsWith("run "));
    if (run === undefined) throw new Error(`no docker run recorded:\n${lines.join("\n")}`);
    return run;
  }

  it("rejects invalid Codex args before session materialization", async () => {
    await vi.resetModules();
    const generateId = vi.fn(async () => {
      throw new Error("generateId should not be reached for invalid codex args");
    });
    const { launch: isolatedLaunch, ensureImage, resolveCredentials, startRuntimeAuthRefresh } =
      await importLaunchWithMocks({ generateId });

    await expect(
      isolatedLaunch(baseOptions({ codexArgs: ["--skip-git-repo-check"] })),
    ).rejects.toThrow(/process\.exit\(1\)/);

    const stderrLines = stderrSpy.mock.calls.map((args) => String(args[0]));
    expect(stderrLines.some((line) => line.includes("--skip-git-repo-check"))).toBe(true);
    expect(generateId).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(ensureImage).not.toHaveBeenCalled();
    expect(startRuntimeAuthRefresh).not.toHaveBeenCalled();
    expect(sessionEntries()).toEqual([]);
  });

  it("rejects unsupported exact CODEX_VERSION before image resolution", async () => {
    const ensureImage = vi.fn(async () => {
      throw new Error("ensureImage should not be reached for unsupported CODEX_VERSION");
    });
    const { launch: isolatedLaunch, generateId, resolveCredentials } =
      await importLaunchWithMocks({ ensureImage });

    await expect(
      isolatedLaunch(baseOptions({ dockerBuildArgs: { CODEX_VERSION: "0.129.0" } })),
    ).rejects.toThrow(/process\.exit\(1\)/);

    const stderrLines = stderrSpy.mock.calls.map((args) => String(args[0]));
    expect(stderrLines.some((line) => line.includes("unsupported CODEX_VERSION 0.129.0"))).toBe(true);
    expect(generateId).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(ensureImage).not.toHaveBeenCalled();
    expect(sessionEntries()).toEqual([]);
  });

  it.each([
    ["no workspace repo", () => ({ repos: [], ros: [] }), /agent=codex requires a workspace repo/],
    ["ro-only inputs", () => ({ repos: [], ros: [roDir] }), /agent=codex requires a workspace repo/],
    ["bare without repo", () => ({ repos: [], ros: [], bare: true }), /agent=codex --bare requires --repo/],
    ["resume", () => ({ resume: "00000000-0000-0000-0000-000000000000" }), /--resume is not supported for agent=codex/],
  ])("rejects %s before session materialization", async (_name, makeOverrides, message) => {
    const { launch: isolatedLaunch, generateId, resolveCredentials, ensureImage } =
      await importLaunchWithMocks();

    await expect(isolatedLaunch(baseOptions(makeOverrides()))).rejects.toThrow(/process\.exit\(1\)/);

    const stderrLines = stderrSpy.mock.calls.map((args) => String(args[0]));
    expect(stderrLines.some((line) => message.test(line))).toBe(true);
    expect(generateId).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(ensureImage).not.toHaveBeenCalled();
    expect(sessionEntries()).toEqual([]);
  });

  it("fails selected Codex auth before session materialization", async () => {
    rmSync(join(fakeHome, ".codex", "auth.json"), { force: true });
    const { launch: isolatedLaunch, generateId, resolveCredentials, ensureImage } =
      await importLaunchWithMocks();

    await expect(isolatedLaunch(baseOptions())).rejects.toThrow(/process\.exit\(1\)/);

    const stderrLines = stderrSpy.mock.calls.map((args) => String(args[0]));
    expect(stderrLines.some((line) => line.includes("Codex auth.json is missing"))).toBe(true);
    expect(generateId).not.toHaveBeenCalled();
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(ensureImage).not.toHaveBeenCalled();
    expect(sessionEntries()).toEqual([]);
  });

  it("uses --cp directories as container-visible roots for Codex image validation", async () => {
    const copiedDir = join(root, "copied-assets");
    const imagePath = join(copiedDir, "screenshot.png");
    mkdirSync(copiedDir, { recursive: true });
    writeFileSync(imagePath, "fake image");

    const generateId = vi.fn(async () => {
      throw new Error("generateId should not be reached for missing auth");
    });
    rmSync(join(fakeHome, ".codex", "auth.json"), { force: true });
    const { launch: isolatedLaunch } = await importLaunchWithMocks({ generateId });

    await expect(
      isolatedLaunch(baseOptions({ cp: [copiedDir], codexArgs: ["--image", imagePath] })),
    ).rejects.toThrow(/process\.exit\(1\)/);

    const stderrLines = stderrSpy.mock.calls.map((args) => String(args[0]));
    expect(stderrLines.some((line) => line.includes("non-visible image path"))).toBe(false);
    expect(generateId).not.toHaveBeenCalled();
    expect(sessionEntries()).toEqual([]);
  });

  it("preserves default Claude ro-only/no-repo compatibility", async () => {
    const { launch: isolatedLaunch } = await importLaunchWithMocks({
      resolveCredentials: vi.fn(async () => ({
        hostPath: join(root, "creds", ".credentials.json"),
        origin: "file",
        refreshResult: { ok: true, action: "fresh", finalJson: "{}", finalTtlMs: Number.NaN },
        finalTtlMs: Number.NaN,
      })),
    });

    await expect(
      isolatedLaunch(baseOptions({ agent: "claude", repos: [], ros: [roDir], claudeArgs: [] })),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("runs selected Codex with Codex env, mounts, argv, manifest, and no Claude watcher", async () => {
    const { launch: isolatedLaunch, resolveCredentials, startRuntimeAuthRefresh, inspectImageContract } =
      await importLaunchWithMocks();

    const result = await isolatedLaunch(baseOptions({ codexArgs: ["--model", "gpt-5-codex"] }));

    const run = dockerRunLine();
    expect(run).toContain("-e CCAIRGAP_AGENT=codex");
    expect(run).toContain("-e CODEX_HOME=/home/claude/.codex");
    expect(run).toContain("-v ");
    expect(run).toContain("/codex-home:/home/claude/.codex:rw");
    expect(run).toContain("/codex-auth/auth.json:/home/claude/.codex/auth.json:rw");
    expect(run).toContain("/codex-sessions:/home/claude/.codex/sessions:rw");
    expect(run.endsWith("ccairgap:test --model gpt-5-codex")).toBe(true);
    expect(resolveCredentials).not.toHaveBeenCalled();
    expect(startRuntimeAuthRefresh).not.toHaveBeenCalled();
    expect(inspectImageContract).toHaveBeenCalledWith("ccairgap:test");

    const manifest = JSON.parse(readFileSync(join(result.sessionDir, "manifest.json"), "utf8")) as {
      agent?: string;
      codex?: { host_home?: string };
    };
    expect(manifest.agent).toBe("codex");
    expect(manifest.codex?.host_home).toBe(join(fakeHome, ".codex"));
  });

  it("allows Codex bare mode when a workspace repo is explicit", async () => {
    const { launch: isolatedLaunch } = await importLaunchWithMocks();

    await expect(
      isolatedLaunch(baseOptions({ bare: true, repos: [repoDir] })),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  it("forwards CODEX_API_KEY only for Codex print mode and treats host auth as advisory", async () => {
    rmSync(join(fakeHome, ".codex", "auth.json"), { force: true });
    process.env.CODEX_API_KEY = "sk-print";
    const { launch: isolatedLaunch } = await importLaunchWithMocks();

    await isolatedLaunch(baseOptions({ print: "summarize", codexArgs: ["--json"] }));

    const run = dockerRunLine();
    expect(run).toContain("-e CCAIRGAP_AGENT=codex");
    expect(run).toContain("-e CCAIRGAP_PRINT=summarize");
    expect(run).toContain("-e CODEX_API_KEY=sk-print");
    expect(run.endsWith("ccairgap:test --json")).toBe(true);
  });
});
