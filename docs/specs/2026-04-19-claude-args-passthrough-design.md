# Claude Arg Passthrough — Design Spec

**Status:** Draft — awaiting user approval
**Date:** 2026-04-19
**Author:** ccairgap maintainers

## Problem

ccairgap currently exposes a small fixed set of `claude` launch flags
(`--print`, `--resume`, `--name`). Every other `claude` flag — `--model`,
`--effort`, `--agent`, `--append-system-prompt`, `--allowed-tools`,
`--fallback-model`, `--verbose`, `--debug`, `--betas`, `--brief`,
`--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections`,
`--setting-sources`, etc. — is unreachable from inside a ccairgap session.

Users who want to pin a model, raise effort, enable betas, or toggle any
other Claude Code behavior currently have no path short of forking the
CLI or editing the entrypoint. Claude Code's flag surface is also a
moving target: new flags land every release, so per-flag mirroring in
ccairgap would be a continuous maintenance burden that always lags.

## Goal

A forward-compatible passthrough: any `claude` flag the user writes in
the ccairgap invocation (or its YAML config) reaches the in-container
`claude` invocation, except for the narrow set ccairgap owns or that
would break the sandbox. New Claude Code flags work the day they ship,
without a ccairgap release.

Shape:

- **CLI:** tokens after `--` are forwarded verbatim.
  `ccairgap --repo . -- --model opus --effort high`.
- **Config:** `claude-args: [...]` list (scalar-per-token, same as what
  would follow `--` on the CLI).
- **Precedence:** config + CLI are concatenated — config first, CLI
  appended (matches existing array-merge convention for
  `extra-repo`, `ro`, `docker-run-arg`, etc.). Last-wins resolution
  for duplicate flags (e.g. two `--model`) is delegated to `claude`
  itself.
- **Denylist:** a small set of flags ccairgap owns or that cannot
  work inside the sandbox. Hard-deny → error with a pointer at the
  ccairgap equivalent. Soft-drop → strip with a stderr warning.

## Non-goals

- Per-flag schema validation. ccairgap does not know `claude`'s flag
  surface beyond the denylist; unknown flags pass through as-is and
  `claude` parses them.
- YAML shorthand. `claude-args` is a list of literal tokens; no map
  form (`claude-args: {model: opus}`). Rationale: value ambiguity
  (bool flags, repeated flags, JSON-string values like `--agents`),
  and zero translation layer keeps passthrough truly forward-compatible.
- Translating denied flags into their ccairgap equivalents. e.g. we do
  **not** silently convert `-r <uuid>` in passthrough into ccairgap's
  `--resume <uuid>`. Users get an explicit error; translating would
  hide the ccairgap-vs-claude flag split.
- Removing `ccairgap --print` / `ccairgap --resume` / `ccairgap --name`
  in favor of passthrough. These three flags drive ccairgap behavior
  (docker TTY flags, clipboard bridge, MCP policy, transcript copy,
  session-id plumbing) — not just forwarded to `claude`. They stay.
- Positional validation. Passthrough may contain positionals (a final
  prompt, or a `claude` subcommand like `auth`, `doctor`, `mcp`,
  `install`, `update`, `plugin`, `setup-token`, `agents`, `auto-mode`).
  Users who write those are opting out of the interactive session —
  their mistake surfaces at `claude` exit, not in ccairgap. Not
  worth the false-positive risk of a positional filter.
- `--help` / `--version` passthrough routing. Soft-dropped (see
  below) — they would cause `claude` to print help and exit inside
  a fully-wired container, which is wasteful and user-confusing.

## Denylist

Organized by reason. Every entry covers all canonical forms:
`--flag`, `-f`, `--flag=val`, `-fval` (short form with inline value).

### HARD deny — ccairgap-owned (use the ccairgap flag instead)

| Claude flag | ccairgap equivalent | Why |
|-------------|---------------------|-----|
| `-n`, `--name` | `ccairgap --name` | session id plumbing; both `CCAIRGAP_NAME` env and `-n` arg are set by the CLI |
| `-r`, `--resume` | `ccairgap --resume` | transcript copy + name→UUID resolution done host-side |
| `-p`, `--print` | `ccairgap --print` | changes docker `-it` → `-i`, disables clipboard bridge, affects MCP policy |

### HARD deny — resume-family (unreachable or conflicts in a fresh clone)

| Claude flag | Why |
|-------------|-----|
| `-c`, `--continue` | "continue most recent in cwd" is meaningless inside a freshly-cloned session workspace |
| `--from-pr` | resume-by-PR — requires github auth; ccairgap containers have no github credentials |
| `--fork-session` | pairs with `-r` / `-c`, both denied; would need translation to ccairgap's resume flow |
| `--session-id` | conflicts with `CCAIRGAP_NAME`-driven id plumbing |

### HARD deny — broken inside the sandbox (host paths or host services)

| Claude flag | Why |
|-------------|-----|
| `--ide` | no IDE socket is exposed into the container |
| `-w`, `--worktree`, `--tmux` | ccairgap IS the isolation layer; a nested worktree inside the container clone makes no sense |
| `--add-dir` | host paths do not resolve in the container |
| `--plugin-dir` | same |
| `--debug-file` | same (the `--debug` flag itself is fine) |
| `--mcp-config` | ccairgap has a hook-policy-style MCP allowlist (`--mcp-enable`); host-path configs bypass it. Use `--mcp-enable` instead |
| `--strict-mcp-config` | pairs with `--mcp-config`; without it, this nukes all MCP |
| `--settings` | both the file-path form (host paths don't resolve) and the JSON-string form (bypasses hook/MCP policy) are denied for a consistent rule. Users with in-session settings needs should instead adjust their host `~/.claude/settings.json` or use `--hook-enable` / `--mcp-enable` |

### SOFT drop (warn on stderr, strip from args)

| Claude flag | Why |
|-------------|-----|
| `--dangerously-skip-permissions` | already set unconditionally by the entrypoint |
| `--allow-dangerously-skip-permissions` | redundant with the above |
| `-h`, `--help` | would print help and exit inside a fully-wired container. Tell the user: run `claude --help` on the host |
| `-v`, `--version` | same — suggest `ccairgap doctor` for the in-image version |

Soft-drop rationale: hard-erroring on these would annoy users who
reasonably assume they're harmless no-ops. The strip-and-warn shape
makes the no-op explicit without killing a session setup.

### Allow (implicit — everything not in the lists above)

All other `claude` flags pass through unchanged. Examples the user
is likely to want today:

`--model`, `--effort`, `--agent`, `--agents`, `--permission-mode`,
`--append-system-prompt`, `--system-prompt`, `--allowed-tools` /
`--allowedTools`, `--disallowed-tools` / `--disallowedTools`,
`--tools`, `--fallback-model`, `--verbose`, `--debug`, `--betas`,
`--bare` (claude's `--bare`, distinct from ccairgap's `--bare`),
`--disable-slash-commands`, `--brief`,
`--exclude-dynamic-system-prompt-sections`, `--setting-sources`,
`--chrome` / `--no-chrome` (no-op in container, harmless),
print-mode companions (`--output-format`, `--input-format`,
`--max-budget-usd`, `--json-schema`, `--no-session-persistence`,
`--include-partial-messages`, `--include-hook-events`,
`--replay-user-messages`) — note these only meaningfully combine
with `ccairgap --print`.

**Forward-compatibility:** any future Claude flag not in the
denylist passes through on day one. If a future flag needs to
join the denylist (e.g. a new host-path flag), that is an
additive ccairgap change.

## User-facing behavior

### CLI invocation

```bash
ccairgap --repo ~/src/foo -- --model opus --effort high --verbose
```

Tokens after `--` are the passthrough. Commander stops consuming
its own flags at `--`; everything after is collected into a new
option `claudeArgs: string[]`.

### Config file

```yaml
# <git-root>/.ccairgap/config.yaml
claude-args:
  - --model
  - opus
  - --effort
  - high
```

Also accepted: `claudeArgs:` (camelCase) — same convention as other
keys. Value must be a list of strings. Empty list / missing key is
equivalent.

### CLI + config together

```yaml
claude-args:
  - --model
  - opus
```

```bash
ccairgap -- --effort high
```

Final passthrough: `--model opus --effort high` (config first, CLI
appended). Inside `claude`, a later `--model` would override an
earlier one; users can rely on that last-wins behavior to override
config values from the CLI (e.g. config sets `--model opus`, CLI
passes `-- --model sonnet` → claude sees both, keeps the last).

### Error messages

**Hard deny (with ccairgap equivalent):**

```
ccairgap: claude-args contains a flag ccairgap manages: -n
  Use: ccairgap --name <name>
```

**Hard deny (no ccairgap equivalent):**

```
ccairgap: claude-args contains a flag that does not work inside the sandbox: --mcp-config
  ccairgap controls MCP via --mcp-enable. See docs/SPEC.md §"MCP policy".
```

Error message names the exact source when the flag came from config:

```
ccairgap: config.yaml: claude-args contains a flag ccairgap manages: -p
  Use: ccairgap --print <prompt>
```

**Soft drop (warn to stderr, no exit):**

```
ccairgap: warning: dropping redundant passthrough arg: --dangerously-skip-permissions (already set by ccairgap)
ccairgap: warning: dropping --help from claude-args (would exit the container before the session starts; run `claude --help` on the host)
```

### Interaction with `ccairgap --print`

`ccairgap --print` continues to drive non-interactive mode (MCP
policy skip, `-i` not `-it`, clipboard bridge off). Users who
additionally want to shape the print output combine the two:

```bash
ccairgap --print "summarize README" -- --output-format json --max-budget-usd 1
```

The entrypoint's existing print branch appends the passthrough
args before `-p "$CCAIRGAP_PRINT"` (see §"Entrypoint changes").

## Design

### CLI layer (`src/cli.ts`)

Commander already understands `--` as a separator. The action
callback receives `cmd.args` which contains positionals — **and**,
after `--`, the raw passthrough. Rather than rely on commander's
internal handling (which varies across versions for what ends up
in `cmd.args` vs `program.args`), the CLI explicitly splits
`process.argv` on the first bare `--` and hands the tail to the
new module.

- Pre-parse step: locate the first `--` in `process.argv` (after
  the ccairgap binary name). Everything before stays as commander's
  input. Everything after becomes `cliClaudeArgs: string[]`.
- The root `.action` gets a new `claudeArgs` value via the
  merge layer; `mergeRun` concatenates `[...cfg.claudeArgs,
  ...cliClaudeArgs]` (config first).
- Subcommands (`list`, `recover`, `discard`, `doctor`, `inspect`,
  `init`) do **not** accept passthrough. The `--` split in
  `process.argv` runs before commander's subcommand dispatch;
  when the first post-program-name token is a subcommand, the
  passthrough tail is silently dropped (no-op — the subcommand
  wouldn't forward it anywhere). Documented as such; not a
  failure mode worth erroring on.

### Config layer (`src/config.ts`)

New key: `claude-args` → internal field `claudeArgs?: string[]`.
Aliases: `claude-args` (kebab, matches CLI mental model) and
`claudeArgs` (camel). Validated via `assertStringArray`. Schema
update:

```ts
export interface ConfigFile {
  // ... existing ...
  claudeArgs?: string[];
}
```

### New module: `src/claudeArgs.ts`

Exports:

```ts
/** Denylist classification of a single flag token. */
type Denial =
  | { kind: "allow" }
  | {
      kind: "hard";
      suggestion?: string; // one-line pointer at ccairgap equivalent or doc
    }
  | { kind: "soft"; reason: string };

/** Lookup a canonical flag name against the denylist. */
export function classifyFlag(flag: string): Denial;

/**
 * Walk a token list and return { filtered, hardDenied, softDropped }.
 * - Tokenizes `--flag=val`, `-fval`, long + short forms.
 * - Non-flag tokens (positionals, flag values) pass through unchanged.
 * - Hard-denied flags appear in `hardDenied` with the canonical form
 *   and the source attribution.
 * - Soft-dropped flags are removed from `filtered` and listed with
 *   their reason.
 */
export function validateClaudeArgs(
  args: string[],
  source: "config" | "cli" | "merged",
): {
  filtered: string[];
  hardDenied: Array<{ token: string; canonical: string; message: string }>;
  softDropped: Array<{ token: string; reason: string }>;
};
```

Denylist data lives as three module-local `Set`s / maps keyed by
canonical long form (with a short→long map for `-n`/`-r`/`-p`/`-c`/
`-v`/`-h` etc.). Caller behavior on hard denies: print each message
to stderr and exit 1 before any session side effects. Soft drops:
print warnings to stderr, continue with `filtered`.

**Token tokenization:** `--flag=value` is split on the first `=`
into `--flag` (lookup target) and `value` (passed through if
flag is allowed). For short-inline form `-fval`, splitting is
only needed to catch denied-short-inline variants like `-nfoo`
(→ `--name foo`). Denied short forms with inline values:
`-n` (required value → `-nfoo` is always `--name foo`), `-r`
(optional value → `-rfoo` is `--resume foo`; bare `-r` is
allowed syntax but denied anyway), `-w` (optional value →
same pattern). `-p`, `-c`, `-h`, `-v` are boolean in claude and
don't take inline values. For allowed flags, we don't attempt
to split `-fval` — the entire token passes through and
`claude` parses it. Rationale: we only need precise parsing
for denied flags; everything else is claude's job.

**Denylist as canonical long-form strings**; the lookup
normalizes short forms first:

```ts
const SHORT_TO_LONG: Record<string, string> = {
  "-n": "--name",
  "-r": "--resume",
  "-p": "--print",
  "-c": "--continue",
  "-v": "--version",
  "-h": "--help",
  "-d": "--debug",
  "-w": "--worktree",
};
```

### Plumbing: CLI → entrypoint

The merged + filtered args are serialized as a JSON array into a
single env var `CCAIRGAP_CLAUDE_ARGS` (empty string when no args).
JSON, not newline-sep, because values like `--agents '{...}'` or
`--json-schema` contain JSON strings with arbitrary characters.

In `launch.ts`, after the existing `CCAIRGAP_PRINT` /
`CCAIRGAP_NAME` / `CCAIRGAP_RESUME` push:

```ts
if (claudeArgs.length > 0) {
  dockerArgs.push("-e", `CCAIRGAP_CLAUDE_ARGS=${JSON.stringify(claudeArgs)}`);
}
```

### Entrypoint changes (`docker/entrypoint.sh`)

After the existing `NAME_ARGS` / `RESUME_ARGS` arrays, parse
`CCAIRGAP_CLAUDE_ARGS` via `jq` into a bash array:

```sh
CLAUDE_EXTRA_ARGS=()
if [ -n "${CCAIRGAP_CLAUDE_ARGS:-}" ]; then
    # jq parses the JSON array; mapfile reads NUL-delimited output so
    # args containing newlines survive.
    mapfile -d '' -t CLAUDE_EXTRA_ARGS < <(jq -r '.[] | (. + "\u0000")' <<< "$CCAIRGAP_CLAUDE_ARGS")
fi
```

Append to both `exec` branches:

```sh
if [ -n "${CCAIRGAP_PRINT:-}" ]; then
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}" "${RESUME_ARGS[@]}" "${CLAUDE_EXTRA_ARGS[@]}" -p "$CCAIRGAP_PRINT"
else
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}" "${RESUME_ARGS[@]}" "${CLAUDE_EXTRA_ARGS[@]}"
fi
```

**Order:** `--dangerously-skip-permissions` → `-n` → `-r` →
**passthrough** → `-p`. Passthrough goes before `-p` so the
final positional-ish `$CCAIRGAP_PRINT` prompt stays last (matches
`claude [options] [prompt]` parsing convention).

Entrypoint does **not** re-validate passthrough — the CLI already
filtered it. The entrypoint is trusted host-built territory; no
denylist in shell.

### Image hash

`CCAIRGAP_CLAUDE_ARGS` plumbing touches `entrypoint.sh`. Image
tag includes `sha256(Dockerfile+entrypoint.sh)[:8]`, so the
entrypoint change produces a fresh tag on first launch after
upgrade. No manual rebuild needed.

## Documentation updates

### `docs/SPEC.md`

1. **§"Command line interface"** (flag table, line 93) — add:

   ```
   | `--` + extra args | - | Passthrough to `claude` inside the container. Everything after `--` is forwarded verbatim to the `claude` invocation (subject to a small denylist — see §"Claude arg passthrough"). Config equivalent: `claude-args: [...]`. |
   ```

2. **New §"Claude arg passthrough"** (between §"Raw docker run args"
   and §"Hook policy"):

   ```
   ## Claude arg passthrough

   Any `claude` launch flag ccairgap does not own can be forwarded
   via `--` on the CLI or `claude-args: [...]` in the config. Both
   sources are concatenated (config first, CLI appended) and the
   result is validated against the denylist below before it reaches
   the container.

   ### Denylist

   (…table from the spec above…)

   ### Plumbing

   CLI → docker run → entrypoint is a single env var:
   `CCAIRGAP_CLAUDE_ARGS` carries the filtered list as a JSON array.
   The entrypoint parses it with `jq` into a bash array and splices
   it into the `exec claude` line between `-r` and `-p`.

   ### Forward compatibility

   Unknown flags (flags not in the allow-by-default set) pass
   through — we only maintain the denylist. If Claude Code ships a
   new flag that is sandbox-incompatible, ccairgap ships a
   denylist addition; until then, new flags work the day they ship.
   ```

3. **§"Config file" key surface row** — add `claude-args` entry.

4. **§"Entrypoint" step 9** — update the claude-args build:

   ```
   9. Build the final `claude` args: always `--dangerously-skip-permissions`; then label, resume, and passthrough:
      - **Label (`-n`):** … (unchanged)
      - **Resume (`-r`):** … (unchanged)
      - **Passthrough (`$CCAIRGAP_CLAUDE_ARGS`):** if set, parsed as a JSON array via `jq` and spliced in. Filtered host-side; entrypoint does not re-validate.
      - Then either `-p "$CCAIRGAP_PRINT"` … (unchanged)
   ```

### `README.md`

1. New row in launch-flags table for the `--` passthrough.
2. Usage example under "Launch" section:

   ```bash
   # Pass any claude flag through
   ccairgap --repo . -- --model opus --effort high

   # Combine with --print
   ccairgap --print "summarize README" --repo . -- --output-format json
   ```

3. Config example block:

   ```yaml
   claude-args:
     - --model
     - opus
     - --effort
     - high
   ```

4. Note on the denylist with a pointer at
   `docs/SPEC.md §"Claude arg passthrough"`.

### `CLAUDE.md`

Add to §"Non-obvious invariants":

> - **Claude flag passthrough is denylist-gated, not allowlist-gated.**
>   `src/claudeArgs.ts` owns the denylist (ccairgap-owned flags,
>   resume-family, sandbox-incompatible, soft-drop noise). Everything
>   else passes through unchanged so new Claude Code flags work the
>   day they ship. CLI `--` tail and `claude-args:` config key are
>   merged (config first, CLI appended) and filtered in one pass;
>   the filtered list is JSON-encoded into `CCAIRGAP_CLAUDE_ARGS`
>   and spliced into the entrypoint's `exec claude` line between
>   the resume args and `-p`. Do not re-validate in the entrypoint
>   — the entrypoint trusts the CLI's filtering. Denylist changes
>   live in one place.

## Edge cases

- **Same flag in config and CLI.** Both forwarded. Claude's
  last-wins semantics resolve. Documented as the intended override
  path.
- **Value-taking flag at the end of CLI with no value.** e.g.
  `ccairgap -- --model`. Passes through; `claude` errors at parse
  time. ccairgap does not pre-validate values (not a ccairgap
  concern; allowlist-with-schema is explicitly non-goal).
- **User passes a positional prompt in passthrough** without
  `ccairgap --print`. e.g. `ccairgap -- "hello"`. Claude treats
  the positional as a prompt, runs, exits. ccairgap's session
  setup ran pointlessly. No safeguard — users who write this
  probably meant `--print`.
- **User passes a `claude` subcommand.** e.g.
  `ccairgap -- auth status`. Claude runs the subcommand and exits.
  Session workspace is built but unused. Same stance: not worth the
  false-positive risk of a positional filter.
- **`--help` / `--version` in passthrough.** Soft-dropped with a
  warning (see denylist table). Alternative considered: pass
  through and let claude exit normally. Rejected because container
  startup work (rsync, jq patches, transcript copy) is wasted; the
  warning+drop preserves intent and avoids the waste.
- **Empty `claude-args: []` in config.** No-op. Same as omitting.
- **Config: wrong type for `claude-args`** (e.g. string). Hard
  error from `assertStringArray` — consistent with other
  list-typed keys.
- **Passthrough tokens that start with `--` but aren't flags.**
  e.g. `--agents '{"foo": "--not-a-flag"}'`. The value belongs to
  `--agents`, not a new flag. The denylist check only runs on
  tokens in flag position (either at the start or after a
  previous flag that doesn't take a value). Value-taking-flag
  table enumerates **both** denied value-taking flags (`-n`,
  `--name`, `-r`, `--resume`, `--from-pr`, `--session-id`,
  `--debug-file`, `--add-dir`, `--plugin-dir`, `--mcp-config`,
  `--settings`, `-w`, `--worktree`) and known allowed
  value-taking flags (`--model`, `--effort`, `--agent`,
  `--agents`, `--permission-mode`, `--append-system-prompt`,
  `--system-prompt`, `--allowed-tools`/`--allowedTools`,
  `--disallowed-tools`/`--disallowedTools`, `--tools`,
  `--fallback-model`, `--betas`, `--mcp-debug`, `--setting-sources`,
  `--output-format`, `--input-format`, `--max-budget-usd`,
  `--json-schema`, `--remote-control-session-name-prefix`,
  `--file`, `--append-system-prompt`). The table is sourced
  from `claude --help`. **Unknown flag tokens default to
  "does not take a value"** — the more conservative choice
  for flag-position tracking, since a false-negative just
  lets an adjacent value be checked against the denylist
  (a real flag name would not collide with a JSON fragment or
  a model name). A false-positive in the other direction
  (consuming the value) would risk masking a denied flag
  sitting behind it.
- **Short flag with inline value where the short is denied.** e.g.
  `-nfoo` (meaning `--name foo`). Tokenizer splits `-n` off, looks
  up denylist, errors. Covers the obscure case where a user
  bypasses `--name` by writing the short-inline form.
- **`--` appears inside a `--docker-run-arg` value.** `shell-quote`
  tokenizes inside `--docker-run-arg` values; that tokenization is
  independent from the top-level `--` split in `process.argv`. No
  interaction — one operates on commander input, the other on
  passthrough tail.

## Testing

All tests in `src/claudeArgs.test.ts` + extensions to
`src/cli.test.ts` / `src/config.test.ts`. Existing handoff /
launch tests untouched.

Cases:

- **Allow list roundtrip.** `--model opus --effort high --verbose`
  → all pass through, no warnings.
- **Hard-deny per category.** One test per denylist entry:
  - `-n foo`, `--name foo` → error + exit 1, message cites
    `ccairgap --name`.
  - `-r uuid`, `--resume uuid` → error + cite `ccairgap --resume`.
  - `-p "prompt"`, `--print "prompt"` → error + cite
    `ccairgap --print`.
  - `-c`, `--continue` → error + resume-family message.
  - `--from-pr 123` → error.
  - `--fork-session` → error.
  - `--session-id uuid` → error.
  - `--ide`, `--tmux`, `-w`, `--worktree` → error.
  - `--add-dir`, `--plugin-dir`, `--debug-file` → error.
  - `--mcp-config`, `--strict-mcp-config` → error.
  - `--settings` → error.
- **Soft-drop per entry.** `--dangerously-skip-permissions`,
  `--allow-dangerously-skip-permissions`, `-h`, `--help`, `-v`,
  `--version` → stripped from filtered list + stderr warning.
- **Form variations.** `--flag=value` form, `-fval` short-inline
  form (for denied value-taking flags only):
  - `--name=foo`, `-nfoo` → both error.
  - `--model=opus` (allowed) → passes through as-is (not split).
- **Config-only.** `claude-args: [--model, opus]` with no CLI tail
  → env carries just config args.
- **CLI-only.** No config, `ccairgap -- --model opus` → env
  carries just CLI args.
- **Merge order.** `claude-args: [--model, opus]` +
  `ccairgap -- --model sonnet` → env carries
  `[--model, opus, --model, sonnet]` (config first).
- **Source attribution in errors.** Deny from config:
  `config.yaml: claude-args contains a flag ccairgap manages: -n`.
  Deny from CLI: no `config.yaml:` prefix.
- **Config type validation.** `claude-args: "model opus"` (string,
  not list) → hard error from `parseConfig`.
- **Empty passthrough.** No `--` on CLI, no `claude-args` in
  config → `CCAIRGAP_CLAUDE_ARGS` env not set (entrypoint falls
  through to empty `CLAUDE_EXTRA_ARGS`).
- **Entrypoint splice.** Integration-style test runs the
  entrypoint in a throwaway shell with a fake `claude` binary
  on PATH that echoes its args; assert the emitted arg order
  is `--dangerously-skip-permissions -n <…> [-r <…>] <passthrough> [-p <…>]`.
  Covers JSON round-trip of value containing spaces / quotes /
  newlines.

## Rollout

- Additive. No existing flag removed or renamed.
- New CLI surface: `--` separator + trailing tokens. Commander
  handles `--` natively; no arg-parsing regression.
- New config key: `claude-args`. Unknown keys already error; users
  on an older CLI who add this key will get a clear error, not
  silent drop.
- No manifest version bump. Manifest schema unchanged.
- Image tag auto-bumps via `entrypoint.sh` content hash.
- Pre-1.0: ship as `feat:` (minor bump per `.versionrc.json`). Not
  a breaking change — prior `ccairgap --` invocations errored
  ("unknown option") and now succeed as passthrough; prior
  `claude-args:` in config errored ("unknown key") and now parses.
- **Exit code:** denylist failures exit 1 with a stderr message
  before any session-dir side effects (same ordering as
  `--resume` validation). Soft-drop warnings are stderr-only;
  launch exit code unchanged.

## Open questions for review

- **Should `--chrome` / `--no-chrome` soft-drop** instead of
  silently passing? They are no-ops in the container (no Chrome).
  Current plan: pass through. If users find the noise confusing,
  we add them to soft-drop later.
- **Should `-d` / `--debug` with the `[filter]` syntax** need
  special handling? The flag accepts an optional value
  (`--debug` or `--debug api,hooks`). Tokenizer treats it as
  not-value-taking by default. Passthrough works: `--debug`
  alone passes through; `--debug api,hooks` passes through as
  two tokens because we don't know about the value. Since
  `--debug` is allowed, claude parses it either way. No
  action needed.
