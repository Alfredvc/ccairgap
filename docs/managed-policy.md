# Managed policy (MDM)

Enterprise / MDM-delivered Claude Code policy files are mounted read-only into the container when present on the host.

## Paths

| Host | Container |
|------|-----------|
| macOS | `/Library/Application Support/ClaudeCode/` → `/etc/claude-code/` |
| Linux | `/etc/claude-code/` → `/etc/claude-code/` (same path, no translation) |
| Windows | unsupported |

The macOS path translation is an explicit exception to ccairgap's usual absolute-path preservation — same precedent as credentials (`/host-claude-creds`). Linux hosts keep identical paths on both sides.

## Skipped when

- The host dir doesn't exist (most users).
- The host is Windows — no MDM forwarding on Windows. ccairgap's existing POSIX-only assumptions (`rsync`, `cp`, `chmod`) already make Windows host support out of scope for this layer.

## What's in scope

This mount covers managed `managed-settings.json` and similar policy files that Claude Code reads from the OS policy dir. Managed MCP tiers (`managed-mcp.json`) and other policy-delivered MCPs are **not** in ccairgap's `--mcp-enable` filter surface — they pass through as the container's own managed policy.
