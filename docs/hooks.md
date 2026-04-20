# Hooks

All Claude Code hooks are **disabled by default** inside the ccairgap sandbox. Opt back in with `--hook-enable <glob>` (repeatable) or `hooks.enable: [<glob>, …]` in config.

## Why off by default

Host hook configs routinely reference binaries that don't exist in the sandboxed container (`afplay`, `/opt/homebrew/bin/...`, project-local `python3` scripts). Left active, every tool call would fail. Defaulting to off lets ccairgap launch cleanly regardless of what the host has configured.

## How the glob works

- Match target: the raw `command` string of each hook entry.
- Wildcard: `*`. Anchored full match (not substring).
- Any hook whose command matches **any** glob in the enable list is kept; everything else is stripped.
- Sources covered uniformly: user `~/.claude/settings.json`, enabled plugins' `hooks/hooks.json`, project `.claude/settings.json[.local]`.

The glob is deliberately thin — users see the exact `command` strings in their JSON, so substring-with-`*` is expressive enough.

## Inspect the actual commands first

Before choosing globs, dump what ccairgap would see:

```bash
# Defaults to cwd if it's a git repo; pass --repo / --extra-repo to match the launch
ccairgap inspect

# Match a launch that mounts a sibling repo alongside
ccairgap inspect --repo ~/src/foo --extra-repo ~/src/bar
```

Output is a JSON array — one object per entry — with `source` (`user` / `plugin` / `project`), `sourcePath`, `event`, `matcher`, `command`, plus `plugin` (marketplace/plugin/version) or `repo` (basename) depending on source. That's the authoritative list across **all three** sources, so you don't miss plugin hooks.

Fallback, if you must walk sources by hand:

```bash
# User-level hooks
jq '.hooks' ~/.claude/settings.json 2>/dev/null

# Project-level hooks
jq '.hooks' <repo>/.claude/settings.json 2>/dev/null
jq '.hooks' <repo>/.claude/settings.local.json 2>/dev/null

# Enabled plugins — must walk every `enabledPlugins[<key>] === true` entry
jq '.enabledPlugins' ~/.claude/settings.json
cat ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/hooks/hooks.json
```

The `command` field is the string you glob against.

## Common patterns

```yaml
hooks:
  enable:
    # All python3 hooks, regardless of script path
    - "python3 *"

    # Exact-match a specific command
    - "node /path/to/audit.js"

    # Any command ending in auto-approve.py (with args after)
    - "*/auto-approve.py *"
    - "*auto-approve.py"            # exact, no args

    # Any uv run … hooks
    - "uv run *"

    # Pattern for a plugin's hook that uses npx
    - "npx -y some-package *"
```

Order doesn't matter; match is OR across entries.

## Keep in mind

- **Enabling ≠ working.** The glob decides what makes it past the filter. The hook's binary still has to exist inside the container. If `python3` isn't installed in your custom image, `python3 *` hooks will match but every invocation will error. Match your enable list to what's installed.
- **Matcher + event structure survives.** The filter only drops inner hook entries; matcher groups (`PreToolUse`/`PostToolUse`/etc.) that become empty are pruned so you don't get junk like `{"PreToolUse": []}`.
- **`command` strings can be long.** If the command is a 400-char inline script, you probably want to target a distinctive substring: `"* # magic-tag *"` — or refactor it into its own script file first.
- **No "enable except X" semantics.** Only additive enable. If you want most-but-not-one, enable the specific ones you want.

## Per-source behavior

- **User settings** (`~/.claude/settings.json`): always processed. `hooks` field replaced with the filtered set (empty `{}` when the enable list is empty); `disableAllHooks` always forced to `false` so the custom `statusLine` keeps running.
- **Plugin hooks**: always processed. For each `enabledPlugins[<plugin>@<market>] === true`, the plugin's `hooks/hooks.json` is filtered and overlaid via a single-file bind mount (filtered = `{}` when the enable list is empty).
- **Project settings** (in the workspace or any `--extra-repo`): always processed. Both `.claude/settings.json` and `.claude/settings.local.json` are filtered and overlaid.

Host files are never mutated; patched copies live under `$SESSION/hook-policy/` and die with the session.

## `statusLine` is not a hook here

ccairgap can't use Claude Code's `disableAllHooks: true` flag (it would also kill the custom `statusLine`), so the empty-enable default neutralizes hook fields directly and leaves `statusLine` running. Don't add the statusline `command` to `hooks.enable` — it's a no-op there. Status line script runs as long as its binary deps exist in the image. To turn it off inside the sandbox, remove it from your host `~/.claude/settings.json` (no per-sandbox toggle).

## Quick decision guide

- Want "all my hooks active in the sandbox" → list every distinct `command` pattern from your config. If it's a dozen, you probably want `"*"` — legal but loses the filter's safety net.
- Want "just my approve-tool hook" → target that command specifically. Exact match beats wildcards when you can. (Status line runs by default — no enable needed.)
- Want "nothing, hooks are noise in the sandbox" → leave `hooks.enable` unset (or omit from config). Default behavior. Status line still runs unless you also remove it from host settings.
- Hook references a binary that isn't in the base image → either add the binary to a custom Dockerfile and enable the hook, or leave it disabled. Don't enable hooks you know will fail.
