import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import {
  filterProjectCodexConfigToml,
  filterProjectCodexHooksJson,
  type CodexPolicyWarning,
} from "./codexConfigPolicy.js";

export interface CodexOverlayWarning {
  code: string;
  message: string;
  source?: string;
}

export interface CodexProjectOverlayResult {
  warnings: CodexOverlayWarning[];
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_TREE_BYTES = 1024 * 1024;
const MAX_DEPTH = 4;

function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function isAllowedSkillFile(path: string): boolean {
  const name = basename(path);
  return (
    extname(name) === ".md" ||
    name === "README" ||
    name === "README.md" ||
    name === "SKILL.md" ||
    name === "skill.md"
  );
}

function ensureSafeRegularFile(path: string): { ok: true; bytes: number } | { ok: false; reason: string } {
  let lst;
  try {
    lst = lstatSync(path);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  if (lst.isSymbolicLink()) return { ok: false, reason: "symlinks are not copied" };
  const st = statSync(path);
  if (!st.isFile()) return { ok: false, reason: "only regular files are copied" };
  if (st.nlink > 1) return { ok: false, reason: "hardlinked files are not copied" };
  if (st.size > MAX_FILE_BYTES) return { ok: false, reason: "file exceeds Codex overlay size limit" };
  if ((st.mode & 0o111) !== 0) return { ok: false, reason: "executable files are not copied" };
  const buf = readFileSync(path);
  if (!isUtf8(buf)) return { ok: false, reason: "non-UTF-8 files are not copied" };
  return { ok: true, bytes: st.size };
}

export function copySafeCodexFile(
  src: string,
  dest: string,
  warnings: CodexOverlayWarning[],
): number {
  const safe = ensureSafeRegularFile(src);
  if (!safe.ok) {
    warnings.push({ code: "unsafe-codex-overlay-file", message: safe.reason, source: src });
    return 0;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(src, dest);
  return safe.bytes;
}

export function copySafeCodexSkillTree(options: {
  srcDir: string;
  destDir: string;
  warnings: CodexOverlayWarning[];
}): void {
  const { srcDir, destDir, warnings } = options;
  if (!existsSync(srcDir)) return;
  const rootStat = lstatSync(srcDir);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    warnings.push({
      code: "unsafe-codex-overlay-tree",
      message: "Codex skill source must be a real directory",
      source: srcDir,
    });
    return;
  }

  let total = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (entry.includes("..") || entry.startsWith(".") || /credential|token|secret/i.test(entry)) {
        warnings.push({
          code: "unsafe-codex-overlay-file",
          message: "hidden, credential, and traversal-like paths are not copied",
          source: join(dir, entry),
        });
        continue;
      }
      const src = join(dir, entry);
      const rel = relative(srcDir, src);
      if (rel.split(sep).length > MAX_DEPTH) {
        warnings.push({
          code: "unsafe-codex-overlay-file",
          message: "Codex skill file exceeds depth limit",
          source: src,
        });
        continue;
      }
      const lst = lstatSync(src);
      if (lst.isSymbolicLink()) {
        warnings.push({ code: "unsafe-codex-overlay-file", message: "symlinks are not copied", source: src });
        continue;
      }
      if (lst.isDirectory()) {
        walk(src);
        continue;
      }
      if (!isAllowedSkillFile(src)) {
        warnings.push({
          code: "unsafe-codex-overlay-file",
          message: "only markdown guidance files are copied from Codex skill trees",
          source: src,
        });
        continue;
      }
      total += copySafeCodexFile(src, join(destDir, rel), warnings);
      if (total > MAX_TREE_BYTES) {
        warnings.push({
          code: "unsafe-codex-overlay-tree",
          message: "Codex skill tree exceeds total size limit",
          source: srcDir,
        });
        rmSync(destDir, { recursive: true, force: true });
        return;
      }
    }
  };
  walk(srcDir);
}

function appendPolicyWarnings(
  warnings: CodexOverlayWarning[],
  policyWarnings: CodexPolicyWarning[],
) {
  warnings.push(...policyWarnings);
}

export function overlayProjectCodexConfig(options: {
  hostPath: string;
  clonePath: string;
  hookEnable?: readonly string[];
  mcpEnable?: readonly string[];
}): CodexProjectOverlayResult {
  const warnings: CodexOverlayWarning[] = [];
  for (const file of ["AGENTS.md", "AGENTS.override.md"]) {
    const src = join(options.hostPath, file);
    if (existsSync(src)) copySafeCodexFile(src, join(options.clonePath, file), warnings);
  }

  const config = join(options.hostPath, ".codex", "config.toml");
  if (existsSync(config)) {
    const safe = ensureSafeRegularFile(config);
    if (safe.ok) {
      const filtered = filterProjectCodexConfigToml({
        toml: readFileSync(config, "utf8"),
        source: config,
        hookEnable: options.hookEnable,
        mcpEnable: options.mcpEnable,
      });
      const dest = join(options.clonePath, ".codex", "config.toml");
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, filtered.content ?? "");
      appendPolicyWarnings(warnings, filtered.warnings);
    } else {
      warnings.push({ code: "unsafe-codex-overlay-file", message: safe.reason, source: config });
    }
  }

  const hooks = join(options.hostPath, ".codex", "hooks.json");
  if (existsSync(hooks)) {
    const safe = ensureSafeRegularFile(hooks);
    if (safe.ok) {
      const filtered = filterProjectCodexHooksJson({
        json: readFileSync(hooks, "utf8"),
        source: hooks,
        hookEnable: options.hookEnable,
      });
      const dest = join(options.clonePath, ".codex", "hooks.json");
      if (filtered.content !== undefined) {
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, filtered.content);
      }
      appendPolicyWarnings(warnings, filtered.warnings);
    } else {
      warnings.push({ code: "unsafe-codex-overlay-file", message: safe.reason, source: hooks });
    }
  }

  copySafeCodexSkillTree({
    srcDir: join(options.hostPath, ".codex", "skills"),
    destDir: join(options.clonePath, ".codex", "skills"),
    warnings,
  });
  copySafeCodexSkillTree({
    srcDir: join(options.hostPath, ".agents", "skills"),
    destDir: join(options.clonePath, ".agents", "skills"),
    warnings,
  });

  return { warnings };
}
