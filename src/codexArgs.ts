import { normalize } from "node:path";
import type { AgentMode } from "./agent.js";

export interface ValidateCodexArgsOptions {
  mode: AgentMode;
  argv: string[];
  visibleRoots?: string[];
  visiblePaths?: string[];
}

const DENIED_SUBCOMMANDS = new Set([
  "exec",
  "e",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "mcp-server",
  "app-server",
  "remote-control",
  "app",
  "completion",
  "update",
  "sandbox",
  "debug",
  "execpolicy",
  "apply",
  "a",
  "resume",
  "fork",
  "cloud",
  "cloud-tasks",
  "responses-api-proxy",
  "stdio-to-uds",
  "exec-server",
  "features",
]);

const DENIED_FLAGS = new Set([
  "--cd",
  "--add-dir",
  "--config",
  "--profile",
  "--enable",
  "--disable",
  "--sandbox",
  "--ask-for-approval",
  "--remote",
  "--remote-auth-token-env",
  "--oss",
  "--local-provider",
  "--dangerously-bypass-approvals-and-sandbox",
  "--yolo",
  "--full-auto",
]);

const PRINT_DENIED_FLAGS = new Set([
  "--ignore-user-config",
  "--ignore-rules",
  "--ephemeral",
  "--skip-git-repo-check",
]);

const SHORT_TO_LONG: Record<string, string> = {
  "-C": "--cd",
  "-a": "--ask-for-approval",
  "-c": "--config",
  "-i": "--image",
  "-m": "--model",
  "-o": "--output-last-message",
  "-p": "--profile",
  "-s": "--sandbox",
};

const INTERACTIVE_FLAGS = new Set(["--image", "--model", "--search", "--no-alt-screen"]);
const PRINT_FLAGS = new Set(["--image", "--model", "--output-schema", "--color", "--output-last-message", "--json"]);
const VALUE_TAKING_FLAGS = new Set(["--image", "--model", "--output-schema", "--color", "--output-last-message"]);

interface ParsedFlag {
  canonical: string;
  inlineValue?: string;
}

export function validateCodexArgs(options: ValidateCodexArgsOptions): string[] {
  if (options.mode.agent !== "codex") {
    throw new Error(`codex args validator received non-codex mode: ${options.mode.agent}`);
  }

  const isPrintMode = options.mode.print !== undefined;
  let positionalCount = 0;

  for (let i = 0; i < options.argv.length; i++) {
    const token = options.argv[i]!;

    if (token === "--") {
      throw new Error("Codex passthrough contains invalid separator token: --");
    }

    const parsed = parseFlag(token);
    if (parsed === undefined) {
      validatePositional(token, isPrintMode, positionalCount);
      positionalCount++;
      continue;
    }

    rejectDeniedFlag(token, parsed.canonical, isPrintMode);
    rejectUnknownFlag(token, parsed.canonical, isPrintMode);

    if (!VALUE_TAKING_FLAGS.has(parsed.canonical) && parsed.inlineValue !== undefined) {
      throw new Error(`Codex passthrough flag does not take a value: ${token}`);
    }

    if (VALUE_TAKING_FLAGS.has(parsed.canonical)) {
      const values = parsed.inlineValue !== undefined
        ? [parsed.inlineValue]
        : readFollowingValues(options.argv, i, parsed.canonical, token);
      if (parsed.inlineValue === undefined) i += values.length;
      for (const value of values) validateValuePresent(token, value);
      if (parsed.canonical === "--image") {
        for (const value of values) {
          validateImageValue(token, value, options.visibleRoots ?? [], options.visiblePaths ?? []);
        }
      }
    }
  }

  return [...options.argv];
}

function parseFlag(token: string): ParsedFlag | undefined {
  if (!token.startsWith("-") || token === "-") return undefined;

  if (token.startsWith("--")) {
    const equalsIndex = token.indexOf("=");
    if (equalsIndex >= 0) {
      return {
        canonical: token.slice(0, equalsIndex),
        inlineValue: token.slice(equalsIndex + 1),
      };
    }
    return { canonical: token };
  }

  const short = token.slice(0, 2);
  const canonical = SHORT_TO_LONG[short];
  if (canonical === undefined) {
    return { canonical: token };
  }

  const inlineValue = token.length > 2 ? token.slice(2) : undefined;
  return { canonical, inlineValue };
}

function validatePositional(token: string, isPrintMode: boolean, positionalCount: number): void {
  if (DENIED_SUBCOMMANDS.has(token)) {
    throw new Error(`Codex passthrough contains denied subcommand: ${token}`);
  }
  if (isPrintMode) {
    throw new Error(`Codex print mode does not allow passthrough positional prompt: ${token}`);
  }
  if (positionalCount > 0) {
    throw new Error(`Codex interactive mode allows at most one positional prompt; offending token: ${token}`);
  }
}

function rejectDeniedFlag(token: string, canonical: string, isPrintMode: boolean): void {
  if (DENIED_FLAGS.has(canonical) || (isPrintMode && PRINT_DENIED_FLAGS.has(canonical))) {
    const canonicalMessage = canonical === token ? "" : ` (canonical: ${canonical})`;
    throw new Error(`Codex passthrough contains denied flag: ${token}${canonicalMessage}`);
  }
}

function rejectUnknownFlag(token: string, canonical: string, isPrintMode: boolean): void {
  const allowedFlags = isPrintMode ? PRINT_FLAGS : INTERACTIVE_FLAGS;
  if (!allowedFlags.has(canonical)) {
    const canonicalMessage = canonical === token ? "" : ` (canonical: ${canonical})`;
    throw new Error(`Codex passthrough contains unknown or unsupported flag: ${token}${canonicalMessage}`);
  }
}

function readFollowingValues(
  argv: string[],
  index: number,
  canonical: string,
  token: string,
): string[] {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`Codex passthrough flag requires a value: ${token}`);
  }
  if (canonical !== "--image") return [value];

  const values: string[] = [];
  for (let i = index + 1; i < argv.length; i++) {
    const candidate = argv[i]!;
    if (candidate.startsWith("-")) break;
    values.push(candidate);
  }
  return values;
}

function validateValuePresent(token: string, value: string): void {
  if (value.length === 0) {
    throw new Error(`Codex passthrough flag requires a value: ${token}`);
  }
}

function validateImageValue(token: string, value: string, visibleRoots: string[], visiblePaths: string[]): void {
  for (const imagePath of value.split(",")) {
    if (imagePath.length === 0 || !isVisiblePath(imagePath, visibleRoots, visiblePaths)) {
      throw new Error(`Codex passthrough ${token} references a host-only or non-visible image path: ${imagePath}`);
    }
  }
}

function isVisiblePath(candidate: string, visibleRoots: string[], visiblePaths: string[]): boolean {
  const normalizedCandidate = normalize(candidate);
  if (visiblePaths.map((p) => normalize(p)).includes(normalizedCandidate)) return true;

  return visibleRoots.map((p) => normalize(p)).some((root) => {
    if (root === normalizedCandidate) return true;
    const prefix = root.endsWith("/") ? root : `${root}/`;
    return normalizedCandidate.startsWith(prefix);
  });
}
