import { describe, expect, it, beforeEach, afterEach, vi, type MockInstance } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";

// Mock handoff → no-op. Without this, a clean session + empty sandbox branch
// triggers `rm -rf $SESSION` at the end of launch() and the overlay state we
// want to inspect disappears with it.
vi.mock("./handoff.js", () => ({
  handoff: vi.fn(async () => ({
    sessionDir: "",
    id: "",
    fetched: [],
    transcriptsCopied: 0,
    removed: false,
    preserved: false,
    warnings: [],
  })),
}));

// Imported AFTER vi.mock above so the mock is wired before launch resolves handoff.
import { launch } from "./launch.js";

let root: string;
let ccairgapHome: string;
let fakeHome: string;
let fakeBinDir: string;
let savedEnv: Record<string, string | undefined>;
let stderrSpy: MockInstance<(...args: unknown[]) => void>;

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  execaSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execaSync("git", ["config", "user.email", "t@t"], { cwd: dir });
  execaSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  execaSync("git", ["add", "seed.txt"], { cwd: dir });
  execaSync("git", ["commit", "-qm", "seed"], { cwd: dir });
}

/** Session clone path for a given repo basename under the sessions root. */
function findSessionClone(sessionsRoot: string, id: string, basename: string): string {
  const repos = join(sessionsRoot, id, "repos");
  const entries = readdirSync(repos);
  const match = entries.find((e) => e.startsWith(`${basename}-`));
  if (!match) throw new Error(`no session clone starting with ${basename}- in ${repos}`);
  return join(repos, match);
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-overlay-launch-")));
  ccairgapHome = join(root, "state");
  fakeHome = join(root, "home");
  fakeBinDir = join(root, "bin");
  mkdirSync(ccairgapHome, { recursive: true });
  mkdirSync(fakeHome, { recursive: true });
  mkdirSync(join(fakeHome, ".claude"), { recursive: true });
  mkdirSync(fakeBinDir, { recursive: true });

  // Fake docker: exits 0 so image-inspect + docker-run both succeed without a daemon.
  const dockerStub = join(fakeBinDir, "docker");
  writeFileSync(dockerStub, "#!/bin/sh\nexit 0\n");
  chmodSync(dockerStub, 0o755);

  // Stub macOS `security` so credentials resolve cross-platform.
  const securityStub = join(fakeBinDir, "security");
  writeFileSync(
    securityStub,
    '#!/bin/sh\nprintf \'%s\' \'{"claudeAiOauth":{"accessToken":"fake"}}\'\nexit 0\n',
  );
  chmodSync(securityStub, 0o755);
  writeFileSync(
    join(fakeHome, ".claude", ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"fake"}}',
  );
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

function baseOpts(repos: string[], extra: Partial<Parameters<typeof launch>[0]> = {}): Parameters<typeof launch>[0] {
  return {
    repos,
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
    ...extra,
  };
}

describe("launch — project Claude config overlay integration", () => {
  it("copies host working-tree .claude, .mcp.json, CLAUDE.md into the session clone", async () => {
    const repo = join(root, "repo");
    initRepo(repo);
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.local.json"),
      '{"enabledMcpjsonServers":["myserver"]}\n',
    );
    writeFileSync(join(repo, ".claude", "skills", "foo.md"), "foo-skill\n");
    writeFileSync(join(repo, ".mcp.json"), '{"mcpServers":{"myserver":{"command":"x"}}}\n');
    writeFileSync(join(repo, "CLAUDE.md"), "project memory\n");

    const result = await launch(baseOpts([repo]));
    const clone = findSessionClone(join(ccairgapHome, "sessions"), result.id, "repo");

    expect(readFileSync(join(clone, ".claude", "settings.local.json"), "utf8")).toBe(
      '{"enabledMcpjsonServers":["myserver"]}\n',
    );
    expect(readFileSync(join(clone, ".claude", "skills", "foo.md"), "utf8")).toBe(
      "foo-skill\n",
    );
    expect(readFileSync(join(clone, ".mcp.json"), "utf8")).toBe(
      '{"mcpServers":{"myserver":{"command":"x"}}}\n',
    );
    expect(readFileSync(join(clone, "CLAUDE.md"), "utf8")).toBe("project memory\n");
  });

  it("hook policy filters hooks from overlaid (uncommitted) settings.json", async () => {
    const repo = join(root, "repo");
    initRepo(repo);
    // Uncommitted host working-tree settings.json declaring a PostToolUse hook.
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { hooks: [{ type: "command", command: "/bin/echo project-hook" }] },
          ],
        },
      }) + "\n",
    );

    const result = await launch(baseOpts([repo], { hookEnable: [] }));

    // Hook policy wrote its filtered copy under $SESSION/hook-policy/projects/<alternatesName>/settings.json.
    const hookPolicyRoot = join(ccairgapHome, "sessions", result.id, "hook-policy", "projects");
    const alts = readdirSync(hookPolicyRoot);
    expect(alts.length).toBe(1);
    const patched = JSON.parse(
      readFileSync(join(hookPolicyRoot, alts[0]!, "settings.json"), "utf8"),
    );
    // hookEnable: [] → every hook neutralized. Proves the overlay fed the policy.
    expect(patched.hooks).toEqual({});
  });

  it("hook policy keeps an overlaid hook when --hook-enable matches its command", async () => {
    const repo = join(root, "repo");
    initRepo(repo);
    mkdirSync(join(repo, ".claude"), { recursive: true });
    writeFileSync(
      join(repo, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            { hooks: [{ type: "command", command: "/bin/echo keep-me" }] },
          ],
        },
      }) + "\n",
    );

    const result = await launch(baseOpts([repo], { hookEnable: ["*keep-me*"] }));
    const hookPolicyRoot = join(ccairgapHome, "sessions", result.id, "hook-policy", "projects");
    const alts = readdirSync(hookPolicyRoot);
    const patched = JSON.parse(
      readFileSync(join(hookPolicyRoot, alts[0]!, "settings.json"), "utf8"),
    );
    expect(patched.hooks.PostToolUse?.[0]?.hooks?.[0]?.command).toBe("/bin/echo keep-me");
  });

  it("mcp policy filters servers from overlaid (uncommitted) .mcp.json", async () => {
    const repo = join(root, "repo");
    initRepo(repo);
    writeFileSync(
      join(repo, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          myserver: { command: "/usr/bin/myserver" },
        },
      }) + "\n",
    );

    const result = await launch(baseOpts([repo], { mcpEnable: [] }));

    const mcpPolicyRoot = join(ccairgapHome, "sessions", result.id, "mcp-policy", "projects");
    const alts = readdirSync(mcpPolicyRoot);
    expect(alts.length).toBe(1);
    const patched = JSON.parse(
      readFileSync(join(mcpPolicyRoot, alts[0]!, ".mcp.json"), "utf8"),
    );
    expect(patched.mcpServers).toEqual({});
  });

  it("multi-repo: each repo in repos[] gets its own overlay", async () => {
    const repoA = join(root, "a");
    const repoB = join(root, "b");
    initRepo(repoA);
    initRepo(repoB);
    mkdirSync(join(repoA, ".claude", "skills"), { recursive: true });
    mkdirSync(join(repoB, ".claude", "skills"), { recursive: true });
    writeFileSync(join(repoA, ".claude", "skills", "tag.txt"), "A\n");
    writeFileSync(join(repoB, ".claude", "skills", "tag.txt"), "B\n");

    // LaunchOptions.repos[0] = workspace, repos[1..] = extras. Both get overlay.
    const result = await launch(baseOpts([repoA, repoB]));

    const cloneA = findSessionClone(join(ccairgapHome, "sessions"), result.id, "a");
    const cloneB = findSessionClone(join(ccairgapHome, "sessions"), result.id, "b");
    expect(readFileSync(join(cloneA, ".claude", "skills", "tag.txt"), "utf8")).toBe("A\n");
    expect(readFileSync(join(cloneB, ".claude", "skills", "tag.txt"), "utf8")).toBe("B\n");
  });

  it("overlay failure (dangling symlink) warns but does not abort launch", async () => {
    const repo = join(root, "repo");
    initRepo(repo);
    mkdirSync(join(repo, ".claude", "skills"), { recursive: true });
    writeFileSync(join(repo, ".claude", "skills", "real.md"), "ok\n");
    symlinkSync(
      "/definitely-not-a-real-path-xyz",
      join(repo, ".claude", "skills", "dangling.md"),
    );

    const result = await launch(baseOpts([repo]));
    // Launch completed — session id was produced.
    expect(result.id).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
    // And the non-dangling file was copied.
    const clone = findSessionClone(join(ccairgapHome, "sessions"), result.id, "repo");
    expect(readFileSync(join(clone, ".claude", "skills", "real.md"), "utf8")).toBe(
      "ok\n",
    );

    // Warning about the overlay failure landed in stderr.
    const stderrLines = stderrSpy.mock.calls.map((args) => args.map(String).join(" "));
    expect(
      stderrLines.some((l) => l.includes("project .claude/skills overlay failed")),
    ).toBe(true);
  });
});
