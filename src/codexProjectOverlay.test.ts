import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { overlayProjectCodexConfig } from "./codexProjectOverlay.js";

let root: string;
let host: string;
let clone: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ccairgap-codex-overlay-"));
  host = join(root, "host");
  clone = join(root, "clone");
  mkdirSync(host, { recursive: true });
  mkdirSync(clone, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("overlayProjectCodexConfig", () => {
  it("copies explicit project guidance and filters project config/hooks", () => {
    writeFileSync(join(host, "AGENTS.md"), "agents\n");
    writeFileSync(join(host, "AGENTS.override.md"), "override\n");
    mkdirSync(join(host, ".codex"), { recursive: true });
    writeFileSync(
      join(host, ".codex", "config.toml"),
      'openai_base_url = "https://example.invalid"\nsafe = "yes"\n',
    );
    writeFileSync(
      join(host, ".codex", "hooks.json"),
      JSON.stringify({ keep: { command: "allowed-hook" }, drop: { command: "blocked" } }),
    );

    overlayProjectCodexConfig({
      hostPath: host,
      clonePath: clone,
      hookEnable: ["allowed-*"],
    });

    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe("agents\n");
    expect(readFileSync(join(clone, "AGENTS.override.md"), "utf8")).toBe("override\n");
    expect(readFileSync(join(clone, ".codex", "config.toml"), "utf8")).toContain(
      'safe = "yes"',
    );
    expect(readFileSync(join(clone, ".codex", "config.toml"), "utf8")).not.toContain(
      "openai_base_url",
    );
    expect(JSON.parse(readFileSync(join(clone, ".codex", "hooks.json"), "utf8"))).toEqual({
      keep: { command: "allowed-hook" },
    });
  });

  it("copies bounded markdown skill trees and omits rules/hooks support dirs", () => {
    mkdirSync(join(host, ".codex", "skills", "demo"), { recursive: true });
    writeFileSync(join(host, ".codex", "skills", "demo", "SKILL.md"), "skill\n");
    mkdirSync(join(host, ".codex", "rules"), { recursive: true });
    writeFileSync(join(host, ".codex", "rules", "policy.star"), "deny\n");
    mkdirSync(join(host, ".codex", "hooks"), { recursive: true });
    writeFileSync(join(host, ".codex", "hooks", "run.sh"), "echo no\n");
    mkdirSync(join(host, ".agents", "skills", "demo"), { recursive: true });
    writeFileSync(join(host, ".agents", "skills", "demo", "README.md"), "agent skill\n");

    overlayProjectCodexConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".codex", "skills", "demo", "SKILL.md"), "utf8")).toBe(
      "skill\n",
    );
    expect(readFileSync(join(clone, ".agents", "skills", "demo", "README.md"), "utf8")).toBe(
      "agent skill\n",
    );
    expect(existsSync(join(clone, ".codex", "rules"))).toBe(false);
    expect(existsSync(join(clone, ".codex", "hooks"))).toBe(false);
  });

  it("rejects symlinks, executable active files, hidden credentials, and non-markdown files", () => {
    mkdirSync(join(host, ".codex", "skills"), { recursive: true });
    writeFileSync(join(host, ".codex", "skills", "safe.md"), "safe\n");
    symlinkSync("safe.md", join(host, ".codex", "skills", "link.md"));
    writeFileSync(join(host, ".codex", "skills", "run.sh"), "echo nope\n");
    chmodSync(join(host, ".codex", "skills", "run.sh"), 0o755);
    writeFileSync(join(host, ".codex", "skills", ".credentials.json"), "{}\n");

    const result = overlayProjectCodexConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".codex", "skills", "safe.md"), "utf8")).toBe("safe\n");
    expect(existsSync(join(clone, ".codex", "skills", "link.md"))).toBe(false);
    expect(existsSync(join(clone, ".codex", "skills", "run.sh"))).toBe(false);
    expect(existsSync(join(clone, ".codex", "skills", ".credentials.json"))).toBe(false);
    expect(result.warnings.length).toBeGreaterThanOrEqual(3);
  });
});
