import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { materializeCodexState } from "./codexState.js";

describe("materializeCodexState", () => {
  let root: string;
  let hostHome: string;
  let sessionDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccairgap-codex-state-"));
    hostHome = join(root, "host-codex");
    sessionDir = join(root, "session");
    mkdirSync(hostHome, { recursive: true });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("materializes session Codex home, auth, sessions, config, and guidance", () => {
    writeFileSync(join(hostHome, "AGENTS.md"), "user guidance\n");
    writeFileSync(join(hostHome, "config.toml"), 'openai_base_url = "https://x"\nsafe = "yes"\n');
    writeFileSync(join(hostHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    mkdirSync(join(hostHome, "skills", "demo"), { recursive: true });
    writeFileSync(join(hostHome, "skills", "demo", "SKILL.md"), "skill\n");

    const plan = materializeCodexState({ sessionDir, hostHome, selected: true });

    expect(readFileSync(join(plan.homeDir, "AGENTS.md"), "utf8")).toBe("user guidance\n");
    expect(readFileSync(join(plan.homeDir, "config.toml"), "utf8")).toContain(
      'cli_auth_credentials_store = "file"',
    );
    expect(readFileSync(join(plan.homeDir, "config.toml"), "utf8")).not.toContain(
      "openai_base_url",
    );
    expect(readFileSync(join(plan.homeDir, "skills", "demo", "SKILL.md"), "utf8")).toBe(
      "skill\n",
    );
    expect(plan.authFile).toBe(join(sessionDir, "codex-auth", "auth.json"));
    expect(existsSync(plan.sessionsDir)).toBe(true);
    if (platform() !== "win32") expect(statSync(plan.authFile ?? "").mode & 0o777).toBe(0o600);
  });

  it("warns and omits advisory auth without throwing", () => {
    const plan = materializeCodexState({ sessionDir, hostHome, selected: false });

    expect(plan.authFile).toBeUndefined();
    expect(plan.warnings.some((w) => w.code === "missing-auth-json")).toBe(true);
  });

  it("materializes symlinked user guidance as regular files", () => {
    writeFileSync(join(hostHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    const target = join(hostHome, "SHARED_AGENTS.md");
    writeFileSync(target, "shared user guidance\n");
    symlinkSync("SHARED_AGENTS.md", join(hostHome, "AGENTS.md"));

    const plan = materializeCodexState({ sessionDir, hostHome, selected: true });

    expect(readFileSync(join(plan.homeDir, "AGENTS.md"), "utf8")).toBe("shared user guidance\n");
    expect(plan.warnings).toEqual([]);
  });

  it("does not copy volatile Codex state", () => {
    writeFileSync(join(hostHome, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-test" }));
    mkdirSync(join(hostHome, "sessions"), { recursive: true });
    writeFileSync(join(hostHome, "sessions", "rollout.jsonl"), "{}\n");
    mkdirSync(join(hostHome, "rules"), { recursive: true });
    writeFileSync(join(hostHome, "rules", "policy.star"), "deny\n");

    const plan = materializeCodexState({ sessionDir, hostHome, selected: true });

    expect(existsSync(join(plan.homeDir, "sessions"))).toBe(false);
    expect(existsSync(join(plan.homeDir, "rules"))).toBe(false);
  });
});
