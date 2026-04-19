#!/usr/bin/env bash
set -euo pipefail

# ccairgap container entrypoint.
# Copies host ~/.claude/ (RO-mounted at /host-claude) into container ~/.claude/,
# patches ~/.claude.json, injects env vars into settings.json, execs claude.

HOME_DIR="${HOME:-/home/claude}"
CLAUDE_DIR="$HOME_DIR/.claude"
HOST_CLAUDE="/host-claude"
HOST_CLAUDE_JSON="/host-claude-json"
HOST_CLAUDE_CREDS="/host-claude-creds"
HOST_PATCHED_SETTINGS="/host-claude-patched-settings.json"
HOST_PATCHED_CLAUDE_JSON="/host-claude-patched-json"

mkdir -p "$CLAUDE_DIR"

# Copy host ~/.claude/ into container ~/.claude/.
# rsync with -L (transform symlinks into files) + explicit excludes handles:
#  - session-local state that shouldn't leak between sessions
#  - plugins/cache (RO-mounted separately at same container path)
#  - .credentials.json (handled via /host-claude-creds)
#  - macOS .DS_Store files at any depth
if [ -d "$HOST_CLAUDE" ]; then
    rsync -rL --chmod=u+w \
        --exclude='projects' \
        --exclude='sessions' \
        --exclude='history.jsonl' \
        --exclude='todos' \
        --exclude='shell-snapshots' \
        --exclude='debug' \
        --exclude='paste-cache' \
        --exclude='session-env' \
        --exclude='file-history' \
        --exclude='plugins/cache' \
        --exclude='.credentials.json' \
        --exclude='.DS_Store' \
        "$HOST_CLAUDE/" "$CLAUDE_DIR/"
fi

# Copy credentials from /host-claude-creds (single-file mount) into ~/.claude/.credentials.json.
if [ -f "$HOST_CLAUDE_CREDS" ]; then
    cp -L "$HOST_CLAUDE_CREDS" "$CLAUDE_DIR/.credentials.json"
    chmod 600 "$CLAUDE_DIR/.credentials.json"
fi

# Clipboard bridge: when the host spawned a per-platform clipboard watcher,
# $SESSION/clipboard-bridge is RO-mounted at /run/ccairgap-clipboard and the
# watcher writes current.png there on every host clipboard change. We install
# a fake wl-paste shim on PATH so Claude Code's image-paste flow reads the
# bridge without ever contacting a real compositor.
#
# Verified Claude Code behavior (see docs/SPEC.md §"Clipboard passthrough"):
# Claude Code calls `xclip ... || wl-paste ...`. The container ships no xclip,
# so xclip exits 127 (command not found) and the fallback runs — hitting our
# shim. If xclip ever ends up in the image, it would take precedence and
# clipboard passthrough silently breaks. Warn loudly so the regression is
# visible at session start.
if [ "${CCAIRGAP_CLIPBOARD_MODE:-}" = "host-bridge" ]; then
    if command -v xclip >/dev/null 2>&1; then
        echo "ccairgap: WARNING — xclip is present in the container image." >&2
        echo "  Claude Code tries xclip before wl-paste; clipboard passthrough will silently fail." >&2
        echo "  This is a ccairgap image regression — please file an issue." >&2
    fi
    SHIM_DIR="$HOME_DIR/.local/bin"
    mkdir -p "$SHIM_DIR"
    cat > "$SHIM_DIR/wl-paste" <<'SHIM_EOF'
#!/bin/sh
# ccairgap fake wl-paste: serves the host clipboard bridge file.
# Claude Code may call: `wl-paste -l` (list MIME types) or
# `wl-paste --type image/png` (retrieve bytes). Claude Code's post-retrieval
# Sharp pipeline auto-converts BMP → PNG, so we serve the bridge bytes
# as-is regardless of their actual format.
BRIDGE=/run/ccairgap-clipboard/current.png
case "$1" in
    -l|--list-types)
        [ -f "$BRIDGE" ] && echo "image/png" && exit 0
        exit 1 ;;
esac
for arg in "$@"; do
    if [ "$arg" = "image/png" ] && [ -f "$BRIDGE" ]; then
        exec cat "$BRIDGE"
    fi
done
exit 1
SHIM_EOF
    chmod +x "$SHIM_DIR/wl-paste"
fi

# Copy and patch ~/.claude.json.
# MCP policy overlay wins: if the host-built patched copy is mounted (strips
# user + user-project `mcpServers` per --mcp-enable), use it as the source so
# the jq onboarding patch layers on top of the filtered MCP state.
if [ -f "$HOST_PATCHED_CLAUDE_JSON" ]; then
    cp -L "$HOST_PATCHED_CLAUDE_JSON" "$HOME_DIR/.claude.json"
    chmod u+w "$HOME_DIR/.claude.json"
elif [ -f "$HOST_CLAUDE_JSON" ]; then
    cp -L "$HOST_CLAUDE_JSON" "$HOME_DIR/.claude.json"
    chmod u+w "$HOME_DIR/.claude.json"
fi
if [ -f "$HOME_DIR/.claude.json" ]; then
    # CCAIRGAP_TRUSTED_CWDS = newline-separated absolute paths for trust-dialog bypass.
    # installMethod / autoUpdatesProtectedForNative stripped: let Claude Code
    # re-detect install method from the binary path (/home/claude/.local/bin/claude)
    # rather than inheriting stale host values.
    TMP_JSON="$(mktemp)"
    jq --arg trusted "${CCAIRGAP_TRUSTED_CWDS:-}" '
        .hasCompletedOnboarding = true
        | del(.installMethod, .autoUpdatesProtectedForNative)
        | (.projects //= {})
        | ($trusted | split("\n") | map(select(length > 0))) as $cwds
        | reduce $cwds[] as $cwd (
            .;
            .projects[$cwd] = ((.projects[$cwd] // {}) + {hasTrustDialogAccepted: true})
          )
    ' "$HOME_DIR/.claude.json" > "$TMP_JSON"
    mv "$TMP_JSON" "$HOME_DIR/.claude.json"
fi

# Hook policy: overlay patched settings.json (strips/keeps hooks per --hook-enable)
# on top of the rsync'd one BEFORE the env-merge jq step so env additions layer on
# top of the filtered hooks.
SETTINGS="$CLAUDE_DIR/settings.json"
if [ -f "$HOST_PATCHED_SETTINGS" ]; then
    cp -L "$HOST_PATCHED_SETTINGS" "$SETTINGS"
fi

# Hook script: emits sessionTitle on every UserPromptSubmit so Claude renames the
# session (same effect as /rename — TUI TextInput border recolors, top-border
# label shows the name, status line reflects the name). `claude -n` alone seeds
# the label but doesn't fire the rename event and doesn't update the status line;
# see the NAME_ARGS block below for why the two values must differ.
# Injected after HOST_PATCHED_SETTINGS so it is not subject to --hook-enable filtering.
TITLE_HOOK="/tmp/ccairgap-session-title.sh"
cat > "$TITLE_HOOK" << 'HOOK_EOF'
#!/bin/sh
TITLE="${CCAIRGAP_NAME:+[ccairgap] $CCAIRGAP_NAME}"
TITLE="${TITLE:-[ccairgap]}"
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"%s"}}\n' "$TITLE"
HOOK_EOF
chmod +x "$TITLE_HOOK"

# Inject env vars + session title hook into settings.json (preserve existing entries).
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
chmod u+w "$SETTINGS"
TMP_SETTINGS="$(mktemp)"
jq --arg hook "$TITLE_HOOK" '.env = (.env // {}) + {
    "DISABLE_AUTOUPDATER": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1"
} | .skipDangerousModePermissionPrompt = true
  | .hooks.UserPromptSubmit = (.hooks.UserPromptSubmit // []) + [
      {"hooks": [{"type": "command", "command": $hook, "timeout": 5}]}
    ]' "$SETTINGS" > "$TMP_SETTINGS"
mv "$TMP_SETTINGS" "$SETTINGS"

# Git identity from host (CLI reads host git config and passes via env).
# Host-side fallback ensures these are set even when host has no config.
if [ -n "${CCAIRGAP_GIT_USER_NAME:-}" ]; then
    git config --global user.name "$CCAIRGAP_GIT_USER_NAME"
fi
if [ -n "${CCAIRGAP_GIT_USER_EMAIL:-}" ]; then
    git config --global user.email "$CCAIRGAP_GIT_USER_EMAIL"
fi

# cwd: first repo path (CCAIRGAP_CWD), else /workspace.
CWD="${CCAIRGAP_CWD:-/workspace}"
mkdir -p "$CWD"
cd "$CWD"

# Session label → `claude -n "ccairgap <id>"` (seeds /resume label + terminal
# title). Intentionally differs from the UserPromptSubmit hook's sessionTitle
# output "[ccairgap] <id>": if the two strings matched, Claude's hook dedup
# would skip the rename and the TUI TextInput border would never recolor.
# CCAIRGAP_NAME carries the full session id from the CLI; the fallback branch
# only runs when the entrypoint is executed directly without the CLI env.
if [ -n "${CCAIRGAP_NAME:-}" ]; then
    NAME_ARGS=(-n "ccairgap $CCAIRGAP_NAME")
else
    NAME_ARGS=(-n "ccairgap")
fi

if [ -n "${CCAIRGAP_PRINT:-}" ]; then
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}" -p "$CCAIRGAP_PRINT"
else
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}"
fi
