import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
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
});
