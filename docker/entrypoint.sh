#!/usr/bin/env bash
set -euo pipefail

# ccairgap container entrypoint.
# Copies host ~/.claude/ (RO-mounted at /host-claude) into container ~/.claude/,
# patches ~/.claude.json, injects env vars into settings.json, execs claude.

HOME_DIR="${HOME:-/home/claude}"
CLAUDE_DIR="$HOME_DIR/.claude"
HOST_CLAUDE="/host-claude"
HOST_CLAUDE_JSON="/host-claude-json"
HOST_CLAUDE_CREDS_DIR="/host-claude-creds-dir"
HOST_PATCHED_SETTINGS="/host-claude-patched-settings.json"
HOST_PATCHED_CLAUDE_JSON="/host-claude-patched-json"

mkdir -p "$CLAUDE_DIR"

# Detect Python virtualenvs anywhere under ~/.claude/ (most commonly inside
# skill or agent dirs). They're excluded from the rsync below because
# `bin/python*` is an absolute symlink into the host's interpreter (pyenv,
# system python, uv-managed) — `rsync -L` follows the link, the target path
# doesn't exist in the container, and the whole transfer aborts (exit 23).
# Even if we copied them, the binaries are host-OS/arch and won't run on
# the Linux container Python. Skill authors must make their skills
# container-compatible (system python3, lazy `pip install`, or `uv run`).
VENVS_FOUND=()
if [ -d "$HOST_CLAUDE" ]; then
    while IFS= read -r venv; do
        VENVS_FOUND+=("${venv#$HOST_CLAUDE/}")
    done < <(find "$HOST_CLAUDE" -maxdepth 5 -type d \( -name .venv -o -name venv \) 2>/dev/null)
fi
if [ ${#VENVS_FOUND[@]} -gt 0 ]; then
    echo "ccairgap: skipping host Python virtualenvs (not portable to container):" >&2
    for v in "${VENVS_FOUND[@]}"; do
        echo "  ~/.claude/$v" >&2
    done
    echo "  Containing skills/agents will load, but their venv binaries will not run." >&2
    echo "  Make Python skills container-compatible: system python3, lazy pip install, or uv run." >&2
fi

# Copy host ~/.claude/ into container ~/.claude/.
# rsync with -L (transform symlinks into files) + explicit excludes handles:
#  - session-local state that shouldn't leak between sessions
#  - plugins/cache (RO-mounted separately at same container path)
#  - .credentials.json (handled via /host-claude-creds-dir)
#  - macOS .DS_Store files at any depth
#  - Python venvs (see VENVS_FOUND block above)
# Exit code 23 ("some files/attrs not transferred") is tolerated with a
# warning so a stray broken symlink (outside the venv pattern) does not
# block session startup. Other exit codes still abort.
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
        --exclude='**/.venv/' \
        --exclude='**/venv/' \
        "$HOST_CLAUDE/" "$CLAUDE_DIR/" || {
            rc=$?
            if [ "$rc" -eq 23 ]; then
                echo "ccairgap: warning — some files in ~/.claude/ could not be copied (likely broken symlinks). Continuing." >&2
            else
                exit "$rc"
            fi
        }
fi

# Symlink credentials from /host-claude-creds-dir/.credentials.json (directory mount).
# The host CLI's runtime auth-refresh watcher atomically rewrites the host file
# (write-tmp + rename), and Claude Code's mtime-cache invalidation
# (auth.ts:1320) picks up the new contents on the next API request.
# `ln -sf` is idempotent across re-launches.
if [ -f "$HOST_CLAUDE_CREDS_DIR/.credentials.json" ]; then
    ln -sf "$HOST_CLAUDE_CREDS_DIR/.credentials.json" "$CLAUDE_DIR/.credentials.json"
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
# `rm -f` before `cp`: base image may bake `/home/claude/.claude.json` owned
# by image-baked UID 1000 (claude.ai/install.sh init). We run as the host UID
# via `docker run --user`; `cp` over an existing file preserves the inode and
# its UID 1000 ownership, after which `chmod u+w` would fail EPERM. Removing
# first guarantees a fresh file owned by the runtime UID.
if [ -f "$HOST_PATCHED_CLAUDE_JSON" ]; then
    rm -f "$HOME_DIR/.claude.json"
    cp -L "$HOST_PATCHED_CLAUDE_JSON" "$HOME_DIR/.claude.json"
elif [ -f "$HOST_CLAUDE_JSON" ]; then
    rm -f "$HOME_DIR/.claude.json"
    cp -L "$HOST_CLAUDE_JSON" "$HOME_DIR/.claude.json"
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
# CCAIRGAP_NAME carries the session id (CLI always sets it). Fallback branch
# only runs when the image is launched directly without the CLI env.
if [ -n "${CCAIRGAP_NAME:-}" ]; then
    TITLE="[ccairgap] $CCAIRGAP_NAME"
else
    TITLE="[ccairgap]"
fi
WARN_FILE="/run/ccairgap-auth-warnings/current.txt"
if [ -f "$WARN_FILE" ] && [ -s "$WARN_FILE" ]; then
    WARN_MSG="$(cat "$WARN_FILE")"
    # Top-level systemMessage surfaces inside the TUI alt-screen — the design
    # spec's chosen field. The hookSpecificOutput.sessionTitle stays the
    # rename trigger.
    jq -nc --arg title "$TITLE" --arg warn "$WARN_MSG" \
      '{systemMessage: $warn, hookSpecificOutput: {hookEventName: "UserPromptSubmit", sessionTitle: $title}}'
else
    jq -nc --arg title "$TITLE" \
      '{hookSpecificOutput: {hookEventName: "UserPromptSubmit", sessionTitle: $title}}'
fi
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

# .ccairgap/ scope overlay: CLAUDE.md, settings.json, mcp.json, skills/
# Two layers: user-wide (~/.config/ccairgap/, mounted at /ccairgap-user-dir)
# applied FIRST, then project (<repo>/.ccairgap/, mounted at /ccairgap-dir).
# All injections are additive (never replace). Injected after the hook-policy
# overlay and main jq pass, so ccairgap hooks/settings are higher priority and
# bypass --hook-enable / --mcp-enable — same design as the built-in title hook.
# Order rationale: user-wide first so project wins on scalar collision.
CCAIRGAP_USER_DIR="${CCAIRGAP_USER_DIR:-/ccairgap-user-dir}"
CCAIRGAP_DIR="/ccairgap-dir"

apply_ccairgap_overlay() {
    local SRC="$1"
    [ -d "$SRC" ] || return 0

    # CLAUDE.md: append to ~/.claude/CLAUDE.md.
    if [ -f "$SRC/CLAUDE.md" ]; then
        printf '\n' >> "$CLAUDE_DIR/CLAUDE.md"
        cat "$SRC/CLAUDE.md" >> "$CLAUDE_DIR/CLAUDE.md"
    fi

    # settings.json: deep-merge into ~/.claude/settings.json.
    # Arrays concatenated (existing first, overlay appended).
    # Scalars/objects: overlay wins. null in overlay is a no-op (existing wins).
    # Requires jq >= 1.6 (node:20-slim ships 1.6).
    if [ -f "$SRC/settings.json" ]; then
        local TMP_S
        TMP_S="$(mktemp)"
        jq -s '
          def mergecc(a; b):
            if b == null then a
            elif a == null then b
            elif ((a | type) == "array" and (b | type) == "array") then (a + b)
            elif ((a | type) == "object" and (b | type) == "object") then
              (((a | keys) + (b | keys)) | unique) as $keys |
              reduce $keys[] as $k ({}; . + {($k): mergecc(a[$k]; b[$k])})
            else b
            end;
          mergecc(.[0]; .[1])
        ' "$SETTINGS" "$SRC/settings.json" > "$TMP_S"
        mv "$TMP_S" "$SETTINGS"
    fi

    # mcp.json: merge mcpServers into ~/.claude.json (user-scope MCP).
    # Creates ~/.claude.json as {} when absent (e.g. fresh unauthenticated install).
    # jq `+` on objects: right-side (overlay) wins on server-name collision.
    # Bypasses --mcp-enable by design — injected after the MCP-policy pass.
    if [ -f "$SRC/mcp.json" ]; then
        [ -f "$HOME_DIR/.claude.json" ] || echo '{}' > "$HOME_DIR/.claude.json"
        local TMP_J
        TMP_J="$(mktemp)"
        jq -s '
          .[0].mcpServers = ((.[0].mcpServers // {}) + (.[1].mcpServers // {}))
        ' "$HOME_DIR/.claude.json" "$SRC/mcp.json" > "$TMP_J"
        mv "$TMP_J" "$HOME_DIR/.claude.json"
    fi

    # skills/: rsync into ~/.claude/skills/ so Claude Code discovers them at user scope.
    # Claude Code's skills scanner reads one level deep: each immediate subdirectory of
    # ~/.claude/skills/ must contain a SKILL.md to be registered as a skill.
    # Name collision: overlay wins (rsync overwrites existing dir).
    # Venv excludes + exit-23 tolerance mirror the main ~/.claude/ rsync block above.
    if [ -d "$SRC/skills" ]; then
        mkdir -p "$CLAUDE_DIR/skills"
        # Detect Python virtualenvs inside overlay skills — same rationale as the
        # main ~/.claude/ rsync block: absolute symlinks into host pyenv/system
        # python don't exist in the container and rsync -L would abort (exit 23).
        local OVERLAY_VENVS_FOUND=()
        while IFS= read -r venv; do
            OVERLAY_VENVS_FOUND+=("${venv#$SRC/skills/}")
        done < <(find "$SRC/skills" -maxdepth 5 -type d \( -name .venv -o -name venv \) 2>/dev/null)
        if [ ${#OVERLAY_VENVS_FOUND[@]} -gt 0 ]; then
            echo "ccairgap: skipping host Python virtualenvs in overlay skills ($SRC):" >&2
            for v in "${OVERLAY_VENVS_FOUND[@]}"; do
                echo "  $v" >&2
            done
            echo "  Containing skills will load, but their venv binaries will not run." >&2
        fi
        local rc=0
        rsync -rL --chmod=u+w \
            --exclude='**/.venv/' \
            --exclude='**/venv/' \
            "$SRC/skills/" "$CLAUDE_DIR/skills/" || rc=$?
        if [ "$rc" -ne 0 ]; then
            if [ "$rc" -eq 23 ]; then
                echo "ccairgap: warning — some files in overlay skills ($SRC) could not be copied (likely broken symlinks). Continuing." >&2
            else
                exit "$rc"
            fi
        fi
    fi
}

apply_ccairgap_overlay "$CCAIRGAP_USER_DIR"
apply_ccairgap_overlay "$CCAIRGAP_DIR"

# Bypass-immune paths advisory: baked-in every session (independent of .ccairgap/).
# Upstream Claude Code enforces a safety gate (src/utils/permissions/permissions.ts
# step 1g and src/utils/permissions/filesystem.ts checkPathSafetyForAutoEdit) that
# ignores --dangerously-skip-permissions for these paths and fires an interactive
# prompt the ccairgap session cannot answer. Inform the model of the consequence
# (advisory, not prohibitive). Mirrors DANGEROUS_DIRECTORIES / DANGEROUS_FILES /
# isClaudeSettingsPath upstream — grow when those change.
# Per SPEC §"Entrypoint" step 9: appended after the .ccairgap/ overlay so it is
# always the last block in ~/.claude/CLAUDE.md regardless of user-supplied content.
cat >> "$CLAUDE_DIR/CLAUDE.md" <<'CAVEAT_EOF'

# ccairgap sandbox — bypass-immune paths

This session runs with `--dangerously-skip-permissions`, but Claude Code's
upstream safety gate ignores bypass mode for the paths below: Edit/Write to
them **will trigger an interactive permission prompt** to the host user,
regardless of bypass.

Paths that trigger the prompt:

- Directories: `.git/`, `.vscode/`, `.idea/`, `.claude/`
- Files: `.gitconfig`, `.gitmodules`, `.bashrc`, `.bash_profile`, `.zshrc`,
  `.zprofile`, `.profile`, `.ripgreprc`, `.mcp.json`, `.claude.json`
- `.claude/settings.json`, `.claude/settings.local.json`

Reading these paths is unaffected. Editing is allowed but requires the host
user to approve each request.
CAVEAT_EOF

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

# Session label → `claude -n "ccairgap <id>"` seeds /resume label + terminal
# title. Intentionally differs from the UserPromptSubmit hook's sessionTitle
# output "[ccairgap] <id>": if the two strings matched, Claude's hook dedup
# would skip the rename and the TUI TextInput border would never recolor.
# CCAIRGAP_NAME carries the full session id from the CLI; the fallback branch
# only runs when the entrypoint is executed directly without the CLI env.
if [ -n "${CCAIRGAP_NAME:-}" ]; then
    NAME_ARGS=(-n "ccairgap $CCAIRGAP_NAME")
else
    NAME_ARGS=(-n "ccairgap")
fi

# Resume: append `-r <uuid>` so claude continues the pre-copied transcript.
RESUME_ARGS=()
if [ -n "${CCAIRGAP_RESUME:-}" ]; then
    RESUME_ARGS=(-r "$CCAIRGAP_RESUME")
fi

# test-only backdoor: see CCAIRGAP_TEST_CMD in CLAUDE.md
if [ -n "${CCAIRGAP_TEST_CMD:-}" ]; then
  exec sh -c "$CCAIRGAP_TEST_CMD"
fi

# Passthrough: tokens forwarded by ccairgap from CLI `--` tail and config
# `claude-args:`. CLI already filtered against the denylist; entrypoint trusts
# the input. Spliced between RESUME_ARGS and -p so that -p (when set) stays
# the final positional, matching claude's prompt-positional convention.
if [ -n "${CCAIRGAP_PRINT:-}" ]; then
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}" "${RESUME_ARGS[@]}" "$@" -p "$CCAIRGAP_PRINT"
else
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}" "${RESUME_ARGS[@]}" "$@"
fi
