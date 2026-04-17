#!/usr/bin/env bash
set -euo pipefail

# claude-airgap container entrypoint.
# Copies host ~/.claude/ (RO-mounted at /host-claude) into container ~/.claude/,
# patches ~/.claude.json, injects env vars into settings.json, execs claude.

HOME_DIR="${HOME:-/home/claude}"
CLAUDE_DIR="$HOME_DIR/.claude"
HOST_CLAUDE="/host-claude"
HOST_CLAUDE_JSON="/host-claude-json"
HOST_CLAUDE_CREDS="/host-claude-creds"
HOST_PATCHED_SETTINGS="/host-claude-patched-settings.json"

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

# Copy and patch ~/.claude.json.
if [ -f "$HOST_CLAUDE_JSON" ]; then
    cp -L "$HOST_CLAUDE_JSON" "$HOME_DIR/.claude.json"
    chmod u+w "$HOME_DIR/.claude.json"

    # AIRGAP_TRUSTED_CWDS = newline-separated absolute paths for trust-dialog bypass.
    TMP_JSON="$(mktemp)"
    jq --arg trusted "${AIRGAP_TRUSTED_CWDS:-}" '
        .hasCompletedOnboarding = true
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

# Inject env vars into settings.json (preserve existing entries).
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
chmod u+w "$SETTINGS"
TMP_SETTINGS="$(mktemp)"
jq '.env = (.env // {}) + {
    "DISABLE_AUTOUPDATER": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1"
} | .skipDangerousModePermissionPrompt = true' "$SETTINGS" > "$TMP_SETTINGS"
mv "$TMP_SETTINGS" "$SETTINGS"

# Git identity from host (CLI reads host git config and passes via env).
# Host-side fallback ensures these are set even when host has no config.
if [ -n "${AIRGAP_GIT_USER_NAME:-}" ]; then
    git config --global user.name "$AIRGAP_GIT_USER_NAME"
fi
if [ -n "${AIRGAP_GIT_USER_EMAIL:-}" ]; then
    git config --global user.email "$AIRGAP_GIT_USER_EMAIL"
fi

# cwd: first repo path (AIRGAP_CWD), else /workspace.
CWD="${AIRGAP_CWD:-/workspace}"
mkdir -p "$CWD"
cd "$CWD"

# Session name → `claude -n <name>` (shown in /resume and terminal title).
NAME_ARGS=()
if [ -n "${AIRGAP_NAME:-}" ]; then
    NAME_ARGS=(-n "$AIRGAP_NAME")
fi

if [ -n "${AIRGAP_PRINT:-}" ]; then
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}" -p "$AIRGAP_PRINT"
else
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}"
fi
