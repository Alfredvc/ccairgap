import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { filterCodexConfigToml, filterCodexHooksJson } from "./codexConfigPolicy.js";
import { planCodexAuth, writeCodexSessionAuth, type CodexAuthWarning } from "./codexAuth.js";
import {
  copySafeCodexFile,
  copySafeCodexSkillTree,
  type CodexOverlayWarning,
} from "./codexProjectOverlay.js";

export interface CodexStateWarning {
  code: string;
  message: string;
  source?: string;
}

export interface CodexStatePlan {
  hostHome: string;
  homeDir: string;
  authDir: string;
  authFile?: string;
  sessionsDir: string;
  warnings: CodexStateWarning[];
}

function copyOptionalFile(src: string, dest: string, warnings: CodexOverlayWarning[]): void {
  if (!existsSync(src)) return;
  copySafeCodexFile(src, dest, warnings, { followSymlinks: true });
}

function asStateWarnings(
  warnings: Array<CodexOverlayWarning | CodexAuthWarning | CodexStateWarning>,
): CodexStateWarning[] {
  return warnings.map((w) => ({ code: w.code, message: w.message, source: w.source }));
}

export function materializeCodexState(options: {
  sessionDir: string;
  hostHome: string;
  selected: boolean;
  homeAgentSkillsDir?: string;
  nowMs?: number;
  hookEnable?: readonly string[];
  mcpEnable?: readonly string[];
}): CodexStatePlan {
  const homeDir = join(options.sessionDir, "codex-home");
  const authDir = join(options.sessionDir, "codex-auth");
  const sessionsDir = join(options.sessionDir, "codex-sessions");
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(authDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });

  const warnings: CodexStateWarning[] = [];
  const overlayWarnings: CodexOverlayWarning[] = [];

  for (const file of ["AGENTS.md", "AGENTS.override.md"]) {
    copyOptionalFile(join(options.hostHome, file), join(homeDir, file), overlayWarnings);
  }

  copySafeCodexSkillTree({
    srcDir: join(options.hostHome, "skills"),
    destDir: join(homeDir, "skills"),
  });
  if (options.homeAgentSkillsDir) {
    copySafeCodexSkillTree({
      srcDir: options.homeAgentSkillsDir,
      destDir: join(homeDir, "skills", "agents"),
    });
  }
  warnings.push(...asStateWarnings(overlayWarnings));

  const userConfig = join(options.hostHome, "config.toml");
  if (existsSync(userConfig)) {
    const filtered = filterCodexConfigToml({
      toml: readFileSync(userConfig, "utf8"),
      source: userConfig,
      hookEnable: options.hookEnable,
      mcpEnable: options.mcpEnable,
    });
    writeFileSync(join(homeDir, "config.toml"), filtered.content ?? "");
    warnings.push(...asStateWarnings(filtered.warnings));
  } else {
    writeFileSync(join(homeDir, "config.toml"), 'cli_auth_credentials_store = "file"\n');
  }

  const userHooks = join(options.hostHome, "hooks.json");
  if (existsSync(userHooks)) {
    const filtered = filterCodexHooksJson({
      json: readFileSync(userHooks, "utf8"),
      source: userHooks,
      hookEnable: options.hookEnable,
    });
    if (filtered.content !== undefined) writeFileSync(join(homeDir, "hooks.json"), filtered.content);
    warnings.push(...asStateWarnings(filtered.warnings));
  }

  const auth = planCodexAuth({
    hostHome: options.hostHome,
    selected: options.selected,
    nowMs: options.nowMs,
  });
  let authFile: string | undefined;
  if (auth.ok && auth.authJson) authFile = writeCodexSessionAuth(options.sessionDir, auth.authJson);
  warnings.push(...asStateWarnings(auth.warnings));

  return {
    hostHome: options.hostHome,
    homeDir,
    authDir,
    authFile,
    sessionsDir,
    warnings,
  };
}
