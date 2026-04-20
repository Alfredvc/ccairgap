/**
 * Denylist + tokenizer for `claude` flag passthrough.
 *
 * Forward-compatible: anything not on the denylist passes through verbatim,
 * so new Claude Code flags work the day they ship. The denylist covers
 * (a) ccairgap-owned flags, (b) the resume family that conflicts with
 * ccairgap's session model, (c) flags that reference host paths or bypass
 * ccairgap's policy layers, and (d) flags pointless inside a fully-wired
 * container. See docs/SPEC.md §"Claude arg passthrough".
 */

export type Denial =
  | { kind: "allow" }
  | { kind: "hard"; suggestion: string }
  | { kind: "soft"; reason: string };

export interface HardDenied {
  /** The exact token the user wrote (preserves `--name=foo`, `-nfoo`, etc.). */
  token: string;
  /** Canonical long form used for the lookup. */
  canonical: string;
  /** Stderr line ready to print, including source attribution. */
  message: string;
}

export interface SoftDropped {
  token: string;
  reason: string;
}

export interface ValidationResult {
  filtered: string[];
  hardDenied: HardDenied[];
  softDropped: SoftDropped[];
}

/** Short-form aliases that resolve to canonical long forms for lookup. */
const SHORT_TO_LONG: Record<string, string> = {
  "-n": "--name",
  "-r": "--resume",
  "-p": "--print",
  "-c": "--continue",
  "-v": "--version",
  "-h": "--help",
  "-w": "--worktree",
};

const HARD_DENY: Record<string, string> = {
  // ccairgap-owned (use the ccairgap flag)
  "--name": "Use: ccairgap --name <name>",
  "--resume": "Use: ccairgap --resume <id-or-name>",
  "--print": "Use: ccairgap --print <prompt>",
  // resume-family (unreachable or conflicts in a fresh clone)
  "--continue": "resume-family: 'continue most recent in cwd' is meaningless inside a freshly-cloned session workspace",
  "--from-pr": "resume-family: --from-pr requires GitHub auth; ccairgap containers have no GitHub credentials",
  "--fork-session": "resume-family: --fork-session pairs with --resume / --continue (both denied)",
  "--session-id": "resume-family: conflicts with CCAIRGAP_NAME-driven session id plumbing",
  // sandbox-broken (host paths or host services)
  "--ide": "IDE socket not exposed by default; use `--docker-run-arg -v /path/to/ide-socket:...` to wire one up",
  "--worktree": "ccairgap IS the isolation layer; use a second `ccairgap` invocation for parallel worktrees",
  "--tmux": "--tmux pairs with --worktree (also denied); tmux binary is not in the container image",
  "--add-dir": "host paths do not resolve in the container; use `ccairgap --ro <path>` to expose a host dir",
  "--plugin-dir": "host paths do not resolve; plugins flow via host `~/.claude/plugins/` RO mount",
  "--debug-file": "host paths do not resolve; use `--debug` and capture container stderr",
  "--mcp-config": "bypasses ccairgap's MCP allowlist (`--mcp-enable`); also references host paths",
  "--strict-mcp-config": "pairs with --mcp-config (also denied)",
  "--settings": "bypasses ccairgap's hook/MCP policy; adjust host `~/.claude/settings.json` or use `--hook-enable` / `--mcp-enable`",
  // pointless inside a fully-wired container
  "--help": "would exit before the session starts; run `claude --help` on the host",
  "--version": "would exit before the session starts; run `ccairgap doctor` for the in-image version",
  "--chrome": "no Chrome binary inside the container; the integration cannot run",
  "--no-chrome": "no Chrome binary inside the container; the integration cannot run",
};

const SOFT_DROP: Record<string, string> = {
  "--dangerously-skip-permissions": "already set by ccairgap",
  "--allow-dangerously-skip-permissions": "redundant — --dangerously-skip-permissions is already set by ccairgap",
};

/**
 * Flags known to take a value (the next argv token is consumed as the value
 * and not classified as a flag). Includes both denied and allowed flags so
 * positional values like `--agents '{"x": "--not-a-flag"}'` don't trigger
 * spurious denylist hits on the JSON content. Sourced from `claude --help`.
 *
 * Unknown flags default to "no value" — see docs/SPEC.md §"Claude arg
 * passthrough" for the rationale (conservative: false-positives surface
 * loudly; the alternative would mask denied tokens).
 */
const VALUE_TAKING = new Set<string>([
  // Denied
  "--name",
  "--resume",
  "--from-pr",
  "--session-id",
  "--debug-file",
  "--add-dir",
  "--plugin-dir",
  "--mcp-config",
  "--settings",
  "--worktree",
  // Allowed
  "--model",
  "--effort",
  "--agent",
  "--agents",
  "--permission-mode",
  "--append-system-prompt",
  "--system-prompt",
  "--allowed-tools",
  "--allowedTools",
  "--disallowed-tools",
  "--disallowedTools",
  "--tools",
  "--fallback-model",
  "--betas",
  "--mcp-debug",
  "--setting-sources",
  "--output-format",
  "--input-format",
  "--max-budget-usd",
  "--json-schema",
  "--remote-control-session-name-prefix",
  "--file",
]);

/** Lookup a canonical long-form flag against the denylist. */
export function classifyFlag(canonical: string): Denial {
  const hard = HARD_DENY[canonical];
  if (hard !== undefined) return { kind: "hard", suggestion: hard };
  const soft = SOFT_DROP[canonical];
  if (soft !== undefined) return { kind: "soft", reason: soft };
  return { kind: "allow" };
}

interface ParsedToken {
  /** Canonical long form used for denylist lookup, or original token if not a flag. */
  canonical: string;
  /** True when the token is a flag (starts with `-` and is not the bare `-` / `--`). */
  isFlag: boolean;
  /** True when the value is inline (`--flag=val` or `-xval` for known short forms). */
  hasInlineValue: boolean;
}

/** Parse a single argv token into its canonical lookup form. */
function parseToken(token: string): ParsedToken {
  if (!token.startsWith("-") || token === "-" || token === "--") {
    return { canonical: token, isFlag: false, hasInlineValue: false };
  }
  if (token.startsWith("--")) {
    const eq = token.indexOf("=");
    if (eq >= 0) {
      return { canonical: token.slice(0, eq), isFlag: true, hasInlineValue: true };
    }
    return { canonical: token, isFlag: true, hasInlineValue: false };
  }
  // short form: -x or -xval
  const short = token.slice(0, 2);
  const long = SHORT_TO_LONG[short];
  if (long) {
    return { canonical: long, isFlag: true, hasInlineValue: token.length > 2 };
  }
  // Unknown short form — pass through verbatim.
  return { canonical: token, isFlag: true, hasInlineValue: false };
}

/**
 * Walk a token list, applying the denylist. Returns the filtered passthrough
 * list (ready to forward to `docker run`), the hard-denied entries (caller
 * exits 1 after printing), and the soft-dropped entries (caller warns and
 * continues).
 *
 * Source attribution is folded into the message so the caller doesn't need
 * to know which denylist branch fired.
 */
export function validateClaudeArgs(args: string[], source: "config" | "cli" | "merged"): ValidationResult {
  const filtered: string[] = [];
  const hardDenied: HardDenied[] = [];
  const softDropped: SoftDropped[] = [];

  for (let i = 0; i < args.length; i++) {
    const tok = args[i]!;
    const parsed = parseToken(tok);

    if (!parsed.isFlag) {
      filtered.push(tok);
      continue;
    }

    const denial = classifyFlag(parsed.canonical);
    if (denial.kind === "hard") {
      hardDenied.push({
        token: tok,
        canonical: parsed.canonical,
        message: formatHardDenyMessage(tok, parsed.canonical, denial.suggestion, source),
      });
      continue;
    }
    if (denial.kind === "soft") {
      softDropped.push({
        token: tok,
        reason: formatSoftDropMessage(tok, denial.reason),
      });
      continue;
    }

    filtered.push(tok);
    if (VALUE_TAKING.has(parsed.canonical) && !parsed.hasInlineValue && i + 1 < args.length) {
      filtered.push(args[i + 1]!);
      i++;
    }
  }

  return { filtered, hardDenied, softDropped };
}

function formatHardDenyMessage(token: string, canonical: string, suggestion: string, source: "config" | "cli" | "merged"): string {
  const prefix = source === "config" ? "config.yaml: claude-args" : "claude-args";
  const lead = `ccairgap: ${prefix} contains a flag ccairgap does not allow: ${token}`;
  const tail = canonical !== token ? ` (canonical: ${canonical})` : "";
  return `${lead}${tail}\n  ${suggestion}`;
}

function formatSoftDropMessage(token: string, reason: string): string {
  return `ccairgap: warning: dropping passthrough arg ${token} (${reason})`;
}
