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

  it("materializes symlinked project guidance as regular files", () => {
    const target = join(host, "SHARED_AGENTS.md");
    writeFileSync(target, "shared agents\n");
    symlinkSync("SHARED_AGENTS.md", join(host, "AGENTS.md"));

    const result = overlayProjectCodexConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, "AGENTS.md"), "utf8")).toBe("shared agents\n");
    expect(result.warnings).toEqual([]);
  });

  it("still rejects symlinked project config files", () => {
    mkdirSync(join(host, ".codex"), { recursive: true });
    const target = join(host, "config.toml");
    const config = join(host, ".codex", "config.toml");
    writeFileSync(target, 'safe = "yes"\n');
    symlinkSync(target, config);

    const result = overlayProjectCodexConfig({ hostPath: host, clonePath: clone });

    expect(existsSync(join(clone, ".codex", "config.toml"))).toBe(false);
    expect(result.warnings).toContainEqual({
      code: "unsafe-codex-overlay-file",
      message: "symlinks are not copied",
      source: config,
    });
  });

  it("copies .codex/skills and .agents/skills but ignores sibling .codex/rules and .codex/hooks dirs", () => {
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

  it("drops dot-files but copies symlinks, executables, and arbitrary files", () => {
    mkdirSync(join(host, ".codex", "skills"), { recursive: true });
    writeFileSync(join(host, ".codex", "skills", "safe.md"), "safe\n");
    symlinkSync("safe.md", join(host, ".codex", "skills", "link.md"));
    writeFileSync(join(host, ".codex", "skills", "run.sh"), "echo go\n");
    chmodSync(join(host, ".codex", "skills", "run.sh"), 0o755);
    writeFileSync(join(host, ".codex", "skills", ".credentials.json"), "{}\n");
    writeFileSync(join(host, ".codex", "skills", ".env"), "SECRET=1\n");

    overlayProjectCodexConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".codex", "skills", "safe.md"), "utf8")).toBe("safe\n");
    expect(readFileSync(join(clone, ".codex", "skills", "link.md"), "utf8")).toBe("safe\n");
    expect(readFileSync(join(clone, ".codex", "skills", "run.sh"), "utf8")).toBe("echo go\n");
    expect(existsSync(join(clone, ".codex", "skills", ".credentials.json"))).toBe(false);
    expect(existsSync(join(clone, ".codex", "skills", ".env"))).toBe(false);
  });

  it("whitelists `.system/` (Anthropic system-skill bucket) but drops other dot-dirs", () => {
    mkdirSync(join(host, ".codex", "skills", ".system", "skill-creator"), { recursive: true });
    writeFileSync(
      join(host, ".codex", "skills", ".system", "skill-creator", "SKILL.md"),
      "sys\n",
    );
    mkdirSync(join(host, ".codex", "skills", ".cache"), { recursive: true });
    writeFileSync(join(host, ".codex", "skills", ".cache", "junk"), "no\n");

    overlayProjectCodexConfig({ hostPath: host, clonePath: clone });

    expect(
      readFileSync(join(clone, ".codex", "skills", ".system", "skill-creator", "SKILL.md"), "utf8"),
    ).toBe("sys\n");
    expect(existsSync(join(clone, ".codex", "skills", ".cache"))).toBe(false);
  });

  it("follows top-level skill-dir symlinks (the ~/.codex/skills/<name> -> ~/.agents/skills/<name> install pattern)", () => {
    const externalSkill = join(root, "external-skill");
    mkdirSync(join(externalSkill, "scripts"), { recursive: true });
    writeFileSync(join(externalSkill, "SKILL.md"), "external\n");
    writeFileSync(join(externalSkill, "scripts", "tool.py"), "print('hi')\n");

    mkdirSync(join(host, ".codex", "skills"), { recursive: true });
    symlinkSync(externalSkill, join(host, ".codex", "skills", "linked"));

    overlayProjectCodexConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".codex", "skills", "linked", "SKILL.md"), "utf8")).toBe(
      "external\n",
    );
    expect(
      readFileSync(join(clone, ".codex", "skills", "linked", "scripts", "tool.py"), "utf8"),
    ).toBe("print('hi')\n");
  });

  it("skips .git, node_modules, .venv, venv when descending (skill symlinked into a source repo must not drag the repo)", () => {
    const externalRepo = join(root, "external-repo-skill");
    mkdirSync(join(externalRepo, ".git", "objects"), { recursive: true });
    writeFileSync(join(externalRepo, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(externalRepo, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(externalRepo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    mkdirSync(join(externalRepo, ".venv", "lib"), { recursive: true });
    writeFileSync(join(externalRepo, ".venv", "lib", "site.py"), "import sys\n");
    mkdirSync(join(externalRepo, "venv"), { recursive: true });
    writeFileSync(join(externalRepo, "venv", "activate"), "echo on\n");
    writeFileSync(join(externalRepo, "SKILL.md"), "kept\n");

    mkdirSync(join(host, ".codex", "skills"), { recursive: true });
    symlinkSync(externalRepo, join(host, ".codex", "skills", "repo-skill"));

    overlayProjectCodexConfig({ hostPath: host, clonePath: clone });

    expect(readFileSync(join(clone, ".codex", "skills", "repo-skill", "SKILL.md"), "utf8")).toBe(
      "kept\n",
    );
    expect(existsSync(join(clone, ".codex", "skills", "repo-skill", ".git"))).toBe(false);
    expect(existsSync(join(clone, ".codex", "skills", "repo-skill", "node_modules"))).toBe(false);
    expect(existsSync(join(clone, ".codex", "skills", "repo-skill", ".venv"))).toBe(false);
    expect(existsSync(join(clone, ".codex", "skills", "repo-skill", "venv"))).toBe(false);
  });
});
