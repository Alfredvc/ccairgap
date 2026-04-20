# `.ccairgap/` — ccairgap-scope Claude config

Files inside `.ccairgap/` are injected into every session, regardless of profile. They are never active when you run `claude` directly.

| File / dir | Effect in container |
|---|---|
| `.ccairgap/CLAUDE.md` | Appended to user-scope `~/.claude/CLAUDE.md` |
| `.ccairgap/settings.json` | Merged into `~/.claude/settings.json` (native Claude Code format) |
| `.ccairgap/mcp.json` | `mcpServers` merged into user-scope MCP (same format as `.mcp.json`) |
| `.ccairgap/skills/` | Each immediate subdirectory containing `SKILL.md` becomes a slash command |

**Note:** Changing `entrypoint.sh` bumps the image content hash, so a new image builds automatically on first launch after upgrading ccairgap. Run `ccairgap doctor` to see the previous image tag; prune via `docker image rm <tag>`.

**Example — deny `AskUserQuestion` in every session:**

`.ccairgap/settings.json`:
```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "AskUserQuestion",
        "hooks": [
          {
            "type": "command",
            "command": "printf '{\"hookSpecificOutput\":{\"hookEventName\":\"PreToolUse\",\"permissionDecision\":\"deny\",\"permissionDecisionReason\":\"Use output text or TodoWrite instead.\"}}'",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

**Example — ccairgap-only skill:**

`.ccairgap/skills/my-tool/SKILL.md` becomes `/my-tool` inside the container only.

**Example — ccairgap-only MCP server:**

`.ccairgap/mcp.json`:
```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "/usr/local/bin/my-mcp-server"
    }
  }
}
```
The command path must be valid inside the container (`node:20-slim` Linux), not on the host.
