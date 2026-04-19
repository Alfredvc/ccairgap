import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlayProjectClaudeConfig } from "./projectClaudeOverlay.js";

let root: string;
let host: string;
let clone: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-overlay-")));
  host = join(root, "host");
  clone = join(root, "clone");
  mkdirSync(host, { recursive: true });
  mkdirSync(clone, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("overlayProjectClaudeConfig", () => {
  it("copies .claude/ dir contents into the clone", async () => {
    mkdirSync(join(host, ".claude", "skills"), { recursive: true });
    writeFileSync(join(host, ".claude", "settings.local.json"), '{"a":1}\n');
    writeFileSync(join(host, ".claude", "skills", "foo.md"), "foo\n");

    await overlayProjectClaudeConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".claude", "settings.local.json"), "utf8")).toBe(
      '{"a":1}\n',
    );
    expect(readFileSync(join(clone, ".claude", "skills", "foo.md"), "utf8")).toBe(
      "foo\n",
    );
  });

  it("merges over an existing clone .claude/ (committed + overlay coexist)", async () => {
    mkdirSync(join(clone, ".claude"), { recursive: true });
    writeFileSync(join(clone, ".claude", "settings.json"), '{"committed":true}\n');

    mkdirSync(join(host, ".claude"), { recursive: true });
    writeFileSync(join(host, ".claude", "settings.local.json"), '{"local":true}\n');

    await overlayProjectClaudeConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".claude", "settings.json"), "utf8")).toBe(
      '{"committed":true}\n',
    );
    expect(readFileSync(join(clone, ".claude", "settings.local.json"), "utf8")).toBe(
      '{"local":true}\n',
    );
  });

  it("overwrites a tracked file in the clone with the host working-tree version", async () => {
    mkdirSync(join(clone, ".claude"), { recursive: true });
    writeFileSync(join(clone, ".claude", "settings.json"), '{"from":"HEAD"}\n');

    mkdirSync(join(host, ".claude"), { recursive: true });
    writeFileSync(join(host, ".claude", "settings.json"), '{"from":"working-tree"}\n');

    await overlayProjectClaudeConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".claude", "settings.json"), "utf8")).toBe(
      '{"from":"working-tree"}\n',
    );
  });

  it("copies .mcp.json and CLAUDE.md from repo root", async () => {
    writeFileSync(join(host, ".mcp.json"), '{"mcpServers":{"a":{}}}\n');
    writeFileSync(join(host, "CLAUDE.md"), "memory\n");

    await overlayProjectClaudeConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".mcp.json"), "utf8")).toBe(
      '{"mcpServers":{"a":{}}}\n',
    );
    expect(readFileSync(join(clone, "CLAUDE.md"), "utf8")).toBe("memory\n");
  });

  it("materializes symlinks (CLAUDE.md → AGENTS.md)", async () => {
    writeFileSync(join(host, "AGENTS.md"), "agents\n");
    symlinkSync("AGENTS.md", join(host, "CLAUDE.md"));

    await overlayProjectClaudeConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, "CLAUDE.md"), "utf8")).toBe("agents\n");
  });

  it("materializes out-of-repo skill symlinks into real files", async () => {
    const shared = join(root, "shared-skills");
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(shared, "ext.md"), "external\n");

    mkdirSync(join(host, ".claude"), { recursive: true });
    symlinkSync(join(shared, "ext.md"), join(host, ".claude", "ext.md"));

    await overlayProjectClaudeConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".claude", "ext.md"), "utf8")).toBe("external\n");
  });

  it("no-ops when host has no overlay paths", async () => {
    await overlayProjectClaudeConfig({ hostPath: host, clonePath: clone });

    expect(existsSync(join(clone, ".claude"))).toBe(false);
    expect(existsSync(join(clone, ".mcp.json"))).toBe(false);
    expect(existsSync(join(clone, "CLAUDE.md"))).toBe(false);
  });

  it("warns but does not throw on dangling symlinks", async () => {
    mkdirSync(join(host, ".claude"), { recursive: true });
    symlinkSync("/nonexistent-target-xyz", join(host, ".claude", "dangling.md"));
    writeFileSync(join(host, ".claude", "real.md"), "ok\n");

    const warnings: string[] = [];
    await overlayProjectClaudeConfig({
      hostPath: host,
      clonePath: clone,
      onWarning: (m) => warnings.push(m),
    });

    expect(readFileSync(join(clone, ".claude", "real.md"), "utf8")).toBe("ok\n");
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });
});
