# Auto-memory

Claude Code's auto-memory directory is exposed to the ccairgap container **read-only**. Claude inside the sandbox can read your accumulated memory; it cannot write back.

## How it works

The host auto-memory directory (resolved per Claude Code's `autoMemoryDirectory` cascade — see `docs/SPEC.md` §"Auto-memory") is bind-mounted read-only at `/host-claude-memory` inside the container. Claude Code is redirected to it via `-e CLAUDE_COWORK_MEMORY_PATH_OVERRIDE=/host-claude-memory`.

Writes from inside the container fail `EROFS` and are swallowed by Claude Code's callers. This is intentional: the host writable paths are a closed set (SPEC §"Host writable paths"), and auto-memory is not one of them.

## Why not nest under `~/.claude/projects/`

- Docker Desktop has a known regression with nested bind mounts that silently misbehaves.
- The handoff flow copies `~/.claude/projects/<encoded>/` back to the host; if auto-memory lived there, container writes would silently propagate to the host, breaking the write-closed-set invariant.

Mounting at a neutral container path (`/host-claude-memory`) and using the env-var redirect avoids both.

## Opt out

`--no-auto-memory` on the CLI or `no-auto-memory: true` in config skips the mount entirely. Use when you want a clean-slate memory in the sandbox.

Don't inject `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` — that kills reads too, which usually isn't what you want.
