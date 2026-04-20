# MCP servers

All Claude Code MCP servers are **disabled by default** inside the ccairgap sandbox. Opt back in with `--mcp-enable <glob>` (repeatable) or `mcp.enable: [<glob>, …]` in config.

## Why off by default

Host MCP configs reference servers that usually can't start cleanly inside the container:

- The server binary isn't installed in the base image.
- The server needs env vars / credentials not passed through (`OPENAI_API_KEY`, `GRAFANA_URL`, etc.).
- The server speaks HTTP/SSE to a host-local service the sandbox network can't reach.
- Project-scope servers (`<repo>/.mcp.json`) come from repo authors you may not fully trust — Claude Code's approval dialog is unreachable inside a non-interactive sandbox.

Defaulting to off lets ccairgap launch cleanly regardless of what the host has configured, and forces explicit opt-in for any capability expansion.

## How the glob works

- Match target: the MCP server **name** — the key under `mcpServers`.
- Wildcard: `*`. Anchored full match (not substring).
- Any server whose name matches **any** glob in the enable list is kept; everything else is stripped.
- Sources covered uniformly: user `~/.claude.json`, user-project `~/.claude.json` `projects[<abs>].mcpServers`, project `<repo>/.mcp.json`, enabled plugin `.mcp.json` and `plugin.json#mcpServers`.

Name is the identifier because MCPs come in three transports (stdio `command`, SSE `url`, HTTP `url`) — only name is universal.

## Project-scope trust gate

`<repo>/.mcp.json` servers require **both** a glob match **and** host approval state = `approved`. Approval on host is established by:

- Clicking "Approve" in the host's `/mcp` TUI for that server, or
- Adding the name to `enabledMcpjsonServers` in user / project / `settings.local.json`, or
- Setting `enableAllProjectMcpServers: true` for that repo's entry.

`disabledMcpjsonServers` always wins — a denied server is stripped regardless of glob.

Inside the airgap container the approval dialog is unreachable (no TUI user), so host approval is the only trust signal available. If a server matches the glob but was never approved on host, it's stripped and Claude Code won't see it.

**User-scope** (top-level `~/.claude.json`) and **plugin-scope** (enabled plugins) have no such gate. Glob match alone is sufficient — you put it in your own config / enabled the plugin yourself.

## Inspect the actual servers first

Before choosing globs, dump what ccairgap would see:

```bash
# Defaults to cwd if it's a git repo; pass --repo / --extra-repo to match the launch
ccairgap inspect

# Pretty table instead of JSON
ccairgap inspect --pretty
```

The `mcpServers` array gives `source` (`user` / `user-project` / `project` / `plugin`), `sourcePath`, `name`, raw `definition` (command/args/url/env/…), `repo` / `plugin` attribution, and `approvalState` for project scope. That's the authoritative list across all four sources.

Fallback hand-walk:

```bash
# User + user-project scope
jq '.mcpServers' ~/.claude.json
jq '.projects | to_entries[] | {(.key): .value.mcpServers}' ~/.claude.json

# Project scope
jq '.mcpServers' <repo>/.mcp.json

# Approval state (must check all four: user settings, project, project-local, ~/.claude.json projects entry)
jq '.enabledMcpjsonServers, .disabledMcpjsonServers, .enableAllProjectMcpServers' ~/.claude/settings.json
```

## Common patterns

```yaml
mcp:
  enable:
    # Exact name match
    - "grafana"
    - "playwright"

    # Glob prefix — anything the team namespaces under codex-
    - "codex-*"

    # Every MCP Claude Code would otherwise see (careful — loses the filter's safety net)
    - "*"
```

Order doesn't matter; match is OR across entries.

## Keep in mind

- **Enabling ≠ working.** The glob decides what gets past the sandbox. Starting the server still requires:
  - The command binary installed in the container image (custom Dockerfile).
  - Any env vars / credentials passed through (`docker-run-arg: ["-e API_KEY"]`).
  - For HTTP/SSE transports, network reachability from the container.
- **Project-scope servers need two gates.** Pass `--mcp-enable` AND make sure the server is approved on host. "I want my project's grafana MCP enabled" without a host approval click will give an empty `mcpServers` inside the container. Approve on host first.
- **No "enable except X" semantics.** Additive enable only. If you want most-but-not-one, enumerate the specific names.
- **Managed MCP tiers** (`/Library/Application Support/ClaudeCode/managed-mcp.json`, MDM/server-delivered) are not mounted into the container at all. Out of scope for ccairgap's filter.

## Per-source behavior

- **User scope** (`~/.claude.json` top-level `mcpServers`): filtered by glob. Written into the patched `~/.claude.json` that overlays via `/host-claude-patched-json`.
- **User-project scope** (`~/.claude.json` `projects[<abs>].mcpServers`): filtered by glob per project key. Same patched file as user scope.
- **Project scope** (`<repo>/.mcp.json`): filtered by glob AND approval state. Overlaid via single-file bind mount at the repo's container path.
- **Plugin scope** (`<plugin>/.mcp.json`, `<plugin>/plugin.json#mcpServers`): for each `enabledPlugins[<plugin>@<market>] === true`, both files are filtered and overlaid via single-file bind mounts (cache-backed plugins over the plugin cache, directory-sourced plugins over the marketplace RO mount).

Host files are never mutated; patched copies live under `$SESSION/mcp-policy/` and die with the session.

## Quick decision guide

- "I need the grafana MCP in the sandbox" → confirm it's declared (`ccairgap inspect`), add `mcp.enable: ["grafana"]`. If it's project-scope and `approvalState: unapproved`, approve on host first (`/mcp` TUI or add to `enabledMcpjsonServers`).
- "I want all my MCPs" → list every distinct name from `ccairgap inspect`. If it's a dozen, `"*"` is legal but loses the filter's safety net.
- "MCPs are noise, I don't want any" → leave `mcp.enable` unset. Default behavior.
- MCP references a binary that isn't in the base image or needs a secret → either extend the Dockerfile + pass the secret via `docker-run-arg: ["-e NAME"]`, or leave it disabled. Don't enable MCPs you know will fail at start.
