import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMounts, type Mount } from "./mounts.js";

let root: string;

function baseInput(r: string) {
  mkdirSync(join(r, "claude"), { recursive: true });
  mkdirSync(join(r, "transcripts"), { recursive: true });
  mkdirSync(join(r, "output"), { recursive: true });
  return {
    hostClaudeDir: join(r, "claude"),
    hostClaudeJson: join(r, "claude", ".claude.json"),
    hostCredsFile: join(r, "claude", "creds"),
    pluginsCacheDir: join(r, "claude", "nocache"), // absent → skipped
    sessionTranscriptsDir: join(r, "transcripts"),
    outputDir: join(r, "output"),
    repos: [] as Array<{
      basename: string;
      sessionClonePath: string;
      hostPath: string;
      realGitDir: string;
      alternatesName: string;
    }>,
    roPaths: [] as string[],
    pluginMarketplaces: [] as string[],
    homeInContainer: "/home/claude",
    extraMounts: [] as Mount[],
    autoMemoryHostDir: undefined as string | undefined,
    managedPolicyHostDir: undefined as string | undefined,
  };
}

describe("buildMounts + collision resolver", () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-mounts-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("produces distinct /host-git-alternates dsts for two repos sharing a basename", () => {
    const a = join(root, "a", "myrepo");
    const b = join(root, "b", "myrepo");
    mkdirSync(join(a, ".git", "objects"), { recursive: true });
    mkdirSync(join(b, ".git", "objects"), { recursive: true });
    const input = baseInput(root);
    input.repos = [
      { basename: "myrepo", sessionClonePath: join(root, "s", "a"), hostPath: a, realGitDir: join(a, ".git"), alternatesName: "myrepo-aaaaaaaa" },
      { basename: "myrepo", sessionClonePath: join(root, "s", "b"), hostPath: b, realGitDir: join(b, ".git"), alternatesName: "myrepo-bbbbbbbb" },
    ];

    const mounts = buildMounts(input);

    const altDsts = mounts.filter((m) => m.dst.startsWith("/host-git-alternates/")).map((m) => m.dst);
    expect(new Set(altDsts).size).toBe(altDsts.length);
    expect(altDsts).toContain("/host-git-alternates/myrepo-aaaaaaaa/objects");
    expect(altDsts).toContain("/host-git-alternates/myrepo-bbbbbbbb/objects");
  });

  it("throws on an exact dst collision between two marketplaces (defense-in-depth)", () => {
    const p = join(root, "mkt");
    mkdirSync(p, { recursive: true });
    const input = baseInput(root);
    input.pluginMarketplaces = [p, p];
    expect(() => buildMounts(input)).toThrow(/duplicate container path/);
  });

  it("throws on --ro reusing a reserved dst (/output)", () => {
    const input = baseInput(root);
    input.roPaths = ["/output"];
    expect(() => buildMounts(input)).toThrow(/\/output.*reserved/);
  });

  it("throws on --ro under /host-git-alternates prefix", () => {
    const input = baseInput(root);
    input.roPaths = ["/host-git-alternates/some-repo/objects"];
    expect(() => buildMounts(input)).toThrow(/host-git-alternates/);
  });

  it("mounts ~/.claude/plugins at host-abs path so known_marketplaces.json installLocation resolves", () => {
    mkdirSync(join(root, "claude", "plugins", "marketplaces", "some-market"), { recursive: true });
    mkdirSync(join(root, "claude", "plugins", "cache", "some-market", "some-plugin", "1.0.0"), { recursive: true });
    const input = baseInput(root);

    const mounts = buildMounts(input);
    const hostPluginsPath = join(root, "claude", "plugins");
    const hostAbsMount = mounts.find((m) => m.src === hostPluginsPath && m.dst === hostPluginsPath);
    expect(hostAbsMount).toBeDefined();
    expect(hostAbsMount?.mode).toBe("ro");
  });

  it("skips host-abs-path plugins mount when host ~/.claude matches container $HOME/.claude", () => {
    mkdirSync(join(root, "home", "claude", ".claude", "plugins"), { recursive: true });
    const input = baseInput(root);
    input.hostClaudeDir = join(root, "home", "claude", ".claude");
    input.homeInContainer = join(root, "home", "claude");

    const mounts = buildMounts(input);
    const hostAbsCandidates = mounts.filter(
      (m) => m.source.kind === "plugins-host-path",
    );
    expect(hostAbsCandidates).toHaveLength(0);
  });

  it("adds an RO auto-memory mount at /host-claude-memory when host dir exists", () => {
    const memoryDir = join(root, "memory-src");
    mkdirSync(memoryDir, { recursive: true });
    writeFileSync(join(memoryDir, "MEMORY.md"), "# seed\n");

    const input = baseInput(root);
    input.autoMemoryHostDir = memoryDir;

    const mounts = buildMounts(input);
    const mem = mounts.find((m) => m.source.kind === "auto-memory");
    expect(mem).toBeDefined();
    expect(mem?.src).toBe(memoryDir);
    expect(mem?.dst).toBe("/host-claude-memory");
    expect(mem?.mode).toBe("ro");
  });

  it("skips the auto-memory mount when the host dir is absent", () => {
    const input = baseInput(root);
    input.autoMemoryHostDir = join(root, "does-not-exist");
    const mounts = buildMounts(input);
    expect(mounts.find((m) => m.source.kind === "auto-memory")).toBeUndefined();
  });

  it("skips the auto-memory mount when autoMemoryHostDir is undefined", () => {
    const input = baseInput(root);
    const mounts = buildMounts(input);
    expect(mounts.find((m) => m.source.kind === "auto-memory")).toBeUndefined();
  });

  it("rejects a user --ro colliding with /host-claude-memory", () => {
    const input = baseInput(root);
    input.roPaths = ["/host-claude-memory"];
    expect(() => buildMounts(input)).toThrow(/\/host-claude-memory.*reserved/);
  });

  it("adds an RO managed-policy mount at /etc/claude-code when host dir exists", () => {
    const hostPolicy = join(root, "etc", "claude-code");
    mkdirSync(hostPolicy, { recursive: true });
    const input = baseInput(root);
    input.managedPolicyHostDir = hostPolicy;

    const mounts = buildMounts(input);
    const mp = mounts.find((m) => m.source.kind === "managed-policy");
    expect(mp).toBeDefined();
    expect(mp?.src).toBe(hostPolicy);
    expect(mp?.dst).toBe("/etc/claude-code");
    expect(mp?.mode).toBe("ro");
  });

  it("skips the managed-policy mount when the host dir is absent", () => {
    const input = baseInput(root);
    input.managedPolicyHostDir = join(root, "etc", "claude-code-missing");
    expect(buildMounts(input).find((m) => m.source.kind === "managed-policy")).toBeUndefined();
  });

  it("rejects a user --ro colliding with /etc/claude-code exactly", () => {
    const input = baseInput(root);
    input.roPaths = ["/etc/claude-code"];
    expect(() => buildMounts(input)).toThrow(/\/etc\/claude-code/);
  });

  it("rejects a user --ro nested under /etc/claude-code/…", () => {
    const input = baseInput(root);
    input.roPaths = ["/etc/claude-code/subdir"];
    expect(() => buildMounts(input)).toThrow(/\/etc\/claude-code/);
  });
});
