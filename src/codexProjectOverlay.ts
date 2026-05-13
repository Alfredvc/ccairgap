import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

const SKILL_TREE_EXCLUDED_SEGMENTS = new Set([".git", ".venv", "venv", "node_modules"]);

function isUtf8(buf: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch {
    return false;
  }
}

function ensureSafeRegularFile(
  path: string,
  options: { followSymlinks?: boolean } = {},
): { ok: true; bytes: number; readPath: string } | { ok: false; reason: string } {
  let lst;
  try {
    lst = lstatSync(path);
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
  let readPath = path;
  if (lst.isSymbolicLink()) {
    if (!options.followSymlinks) return { ok: false, reason: "symlinks are not copied" };
    try {
      readPath = realpathSync(path);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  }
  const st = statSync(readPath);
  if (!st.isFile()) return { ok: false, reason: "only regular files are copied" };
  if (st.nlink > 1) return { ok: false, reason: "hardlinked files are not copied" };
  if (st.size > MAX_FILE_BYTES) return { ok: false, reason: "file exceeds Codex overlay size limit" };
  if ((st.mode & 0o111) !== 0) return { ok: false, reason: "executable files are not copied" };
  const buf = readFileSync(readPath);
  if (!isUtf8(buf)) return { ok: false, reason: "non-UTF-8 files are not copied" };
  return { ok: true, bytes: st.size, readPath };
}

export function copySafeCodexFile(
  src: string,
  dest: string,
  warnings: CodexOverlayWarning[],
  options: { followSymlinks?: boolean } = {},
): number {
  const safe = ensureSafeRegularFile(src, options);
  if (!safe.ok) {
    warnings.push({ code: "unsafe-codex-overlay-file", message: safe.reason, source: src });
    return 0;
  }
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(safe.readPath, dest);
  return safe.bytes;
}

export function copySafeCodexSkillTree(options: {
  srcDir: string;
  destDir: string;
}): void {
  const { srcDir, destDir } = options;
  if (!existsSync(srcDir)) return;

  const visited = new Set<string>();
  let rootReal: string;
  try {
    rootReal = realpathSync(srcDir);
  } catch {
    return;
  }
  visited.add(rootReal);

  const walk = (logicalDir: string, relDir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(logicalDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "." || entry === ".." || entry.includes("/") || entry.includes("\\")) continue;
      if (SKILL_TREE_EXCLUDED_SEGMENTS.has(entry)) continue;
      // `.system/` is Anthropic's system-skills bucket; whitelist at any
      // depth (rare to nest, but harmless if it appears under a sub-skill).
      if (entry.startsWith(".") && entry !== ".system") continue;

      const src = join(logicalDir, entry);
      const rel = relDir === "" ? entry : join(relDir, entry);

      let lst;
      try {
        lst = lstatSync(src);
      } catch {
        continue;
      }

      let readPath = src;
      let isDir = lst.isDirectory();
      let isFile = lst.isFile();

      if (lst.isSymbolicLink()) {
        let canonical: string;
        let st;
        try {
          canonical = realpathSync(src);
          st = statSync(canonical);
        } catch {
          continue;
        }
        readPath = canonical;
        isDir = st.isDirectory();
        isFile = st.isFile();
      }

      if (isDir) {
        const realDir = readPath;
        if (visited.has(realDir)) continue;
        visited.add(realDir);
        walk(realDir, rel);
        continue;
      }
      if (isFile) {
        const dest = join(destDir, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(readPath, dest);
      }
    }
  };
  walk(rootReal, "");
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
    if (existsSync(src)) {
      copySafeCodexFile(src, join(options.clonePath, file), warnings, { followSymlinks: true });
    }
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
  });
  copySafeCodexSkillTree({
    srcDir: join(options.hostPath, ".agents", "skills"),
    destDir: join(options.clonePath, ".agents", "skills"),
  });

  return { warnings };
}
