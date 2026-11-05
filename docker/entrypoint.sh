#!/usr/bin/env bash
set -euo pipefail

# ccairgap container entrypoint.
# Copies host ~/.claude/ (RO-mounted at /host-claude) into container ~/.claude/,
# patches ~/.claude.json, injects env vars into settings.json, execs claude.

HOME_DIR="${HOME:-/home/claude}"
CLAUDE_DIR="$HOME_DIR/.claude"
export CODEX_HOME="${CODEX_HOME:-$HOME_DIR/.codex}"
HOST_CLAUDE="/host-claude"
HOST_CLAUDE_JSON="/host-claude-json"
HOST_CLAUDE_CREDS_DIR="/host-claude-creds-dir"
HOST_PATCHED_SETTINGS="/host-claude-patched-settings.json"
HOST_PATCHED_CLAUDE_JSON="/host-claude-patched-json"

mkdir -p "$CLAUDE_DIR" "$CODEX_HOME" "$CODEX_HOME/sessions"

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
#  - host background-session state (/jobs, /daemon). The leading slash anchors
#    the pattern at the transfer root, so a nested dir of the same name in a
#    skill is kept.
#  - top-level settings.local.json. Claude Code reads it only as project-local
#    settings when the working directory is $HOME, so a copy would let `cd ~`
#    load hooks that the hook policy did not filter.
# Note: absolute symlinks under host ~/.claude/ would normally fail rsync -L
# in the container namespace (their /Users/... targets don't exist). The CLI
# pre-materializes each one in an allowlisted config path host-side and
# mounts the result at /host-claude/<rel>. Docker follows the symlink, so the
# copy lands at the link's target path and rsync -L can read it. See
# src/claudeSymlinkOverlay.ts.
# Exit codes 23 ("some files/attrs not transferred") and 24 ("some source
# files vanished", because host Claude Code keeps writing here) are tolerated
# with a warning to cover any stragglers (e.g. a relative symlink pointing into
# an excluded subtree, or a symlink outside the overlay allowlist). Other
# exit codes still abort.
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
        --exclude='/jobs' \
        --exclude='/daemon' \
        --exclude='/daemon.*' \
        --exclude='/daemon-*' \
        --exclude='/settings.local.json' \
        --exclude='plugins/cache' \
        --exclude='.credentials.json' \
        --exclude='.DS_Store' \
        --exclude='**/.venv/' \
        --exclude='**/venv/' \
        "$HOST_CLAUDE/" "$CLAUDE_DIR/" || {
            rc=$?
            if [ "$rc" -eq 23 ] || [ "$rc" -eq 24 ]; then
                echo "ccairgap: warning — some files in ~/.claude/ could not be copied (broken symlinks or files that changed during the copy). Continuing." >&2
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
# disableAgentView: background sessions stop when PID 1 exits, and handoff does
# not deliver their worktree branches. The .ccairgap overlay below runs later,
# so `"disableAgentView": false` there opts in.
[ -f "$SETTINGS" ] || echo '{}' > "$SETTINGS"
chmod u+w "$SETTINGS"
TMP_SETTINGS="$(mktemp)"
jq --arg hook "$TITLE_HOOK" '.env = (.env // {}) + {
    "DISABLE_AUTOUPDATER": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1"
} | .skipDangerousModePermissionPrompt = true
  | .disableAgentView = true
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
    # Requires jq >= 1.6 (node:24-slim ships 1.6).
    # The parameters must be values ($a), not closures (a). jq evaluates a
    # closure against the current input, which inside reduce is the accumulator.
    if [ -f "$SRC/settings.json" ]; then
        local TMP_S
        TMP_S="$(mktemp)"
        jq -s '
          def mergecc($a; $b):
            if $b == null then $a
            elif $a == null then $b
            elif (($a | type) == "array" and ($b | type) == "array") then ($a + $b)
            elif (($a | type) == "object" and ($b | type) == "object") then
              ((($a | keys) + ($b | keys)) | unique) as $keys |
              reduce $keys[] as $k ({}; . + {($k): mergecc($a[$k]; $b[$k])})
            else $b
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
    # Venv excludes + exit-23/24 tolerance mirror the main ~/.claude/ rsync block above.
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
            if [ "$rc" -eq 23 ] || [ "$rc" -eq 24 ]; then
                echo "ccairgap: warning — some files in overlay skills ($SRC) could not be copied (broken symlinks or files that changed during the copy). Continuing." >&2
            else
                exit "$rc"
            fi
        fi
    fi
}

apply_ccairgap_overlay "$CCAIRGAP_USER_DIR"
apply_ccairgap_overlay "$CCAIRGAP_DIR"

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

# Network policy: the container has only a loopback interface, so every client
# reaches the sidecar through this forwarder. See docs/SPEC.md §"Network policy".
if [ "${CCAIRGAP_NETWORK_POLICY:-}" = "1" ]; then
    cat /etc/ssl/certs/ca-certificates.crt /run/ccairgap-network/agent/ca.pem \
        > /home/claude/.ccairgap-network-ca-bundle.pem
    node /run/ccairgap-network/agent/forwarder.mjs </dev/null >/dev/null 2>&1 &
    forwarder_ready=0
    for _ in $(seq 1 100); do
        if (exec 3<>/dev/tcp/127.0.0.1/3128) 2>/dev/null; then
            forwarder_ready=1
            break
        fi
        sleep 0.1
    done
    if [ "$forwarder_ready" -ne 1 ]; then
        echo "ccairgap: the network forwarder did not start. This image needs node on PATH." >&2
        exit 1
    fi
fi

# test-only backdoor: see CCAIRGAP_TEST_CMD in CLAUDE.md
if [ -n "${CCAIRGAP_TEST_CMD:-}" ]; then
  exec sh -c "$CCAIRGAP_TEST_CMD"
fi

ENTRYPOINT_AGENT="${CCAIRGAP_AGENT:-claude}"
ENTRYPOINT_MODE="${CCAIRGAP_ENTRYPOINT_MODE:-agent}"
CODEX_PRINT_STDIN=0

print_command() {
    local first=1
    for token in "$@"; do
        if [ "$first" -eq 0 ]; then
            printf ' '
        fi
        printf '%q' "$token"
        first=0
    done
    printf '\n'
}

dry_run() {
    local branch="$1"
    shift
    printf 'ccairgap-entrypoint-dry-run\n'
    printf 'branch=%s\n' "$branch"
    printf 'cwd=%s\n' "$CWD"
    printf 'CCAIRGAP_AGENT=%s\n' "$ENTRYPOINT_AGENT"
    printf 'CCAIRGAP_ENTRYPOINT_MODE=%s\n' "$ENTRYPOINT_MODE"
    if [ -n "${CCAIRGAP_PRINT:-}" ]; then
        printf 'CCAIRGAP_PRINT=%s\n' "$CCAIRGAP_PRINT"
    fi
    printf 'CODEX_HOME=%s\n' "$CODEX_HOME"
    if [ -d "$CLAUDE_DIR" ]; then
        printf 'claude_home_ready=1\n'
    else
        printf 'claude_home_ready=0\n'
    fi
    if [ -d "$CODEX_HOME" ]; then
        printf 'codex_home_ready=1\n'
    else
        printf 'codex_home_ready=0\n'
    fi
    if [ -d "$CODEX_HOME/sessions" ]; then
        printf 'codex_sessions_ready=1\n'
    else
        printf 'codex_sessions_ready=0\n'
    fi
    printf 'command='
    print_command "$@"
}

case "$ENTRYPOINT_MODE" in
    agent)
        case "$ENTRYPOINT_AGENT" in
            claude)
                # Passthrough: tokens forwarded by ccairgap from CLI `--` tail and config
                # `claude-args:`. CLI already filtered against the denylist; entrypoint trusts
                # the input. Spliced between RESUME_ARGS and -p so that -p (when set) stays
                # the final positional, matching claude's prompt-positional convention.
                if [ -n "${CCAIRGAP_PRINT:-}" ]; then
                    FINAL_CMD=(claude --dangerously-skip-permissions "${NAME_ARGS[@]}" "${RESUME_ARGS[@]}" "$@" -p "$CCAIRGAP_PRINT")
                else
                    FINAL_CMD=(claude --dangerously-skip-permissions "${NAME_ARGS[@]}" "${RESUME_ARGS[@]}" "$@")
                fi
                ;;
            codex)
                if [ -n "${CCAIRGAP_PRINT:-}" ]; then
                    FINAL_CMD=(codex exec --dangerously-bypass-approvals-and-sandbox --cd "$CWD" "$@" -)
                    CODEX_PRINT_STDIN=1
                else
                    # --no-daemon: the image has no `ps`, which the shared
                    # app-server needs, and ccairgap keeps background servers off.
                    FINAL_CMD=(codex --dangerously-bypass-approvals-and-sandbox --no-daemon --cd "$CWD" "$@")
                fi
                ;;
            *)
                echo "ccairgap: unsupported CCAIRGAP_AGENT: $ENTRYPOINT_AGENT" >&2
                exit 2
                ;;
        esac
        DRY_RUN_BRANCH="$ENTRYPOINT_AGENT"
        ;;
    exec)
        if [ "$#" -eq 0 ]; then
            echo "ccairgap: CCAIRGAP_ENTRYPOINT_MODE=exec requires a command" >&2
            exit 2
        fi
        FINAL_CMD=("$@")
        DRY_RUN_BRANCH="exec"
        ;;
    *)
        echo "ccairgap: unsupported CCAIRGAP_ENTRYPOINT_MODE: $ENTRYPOINT_MODE" >&2
        exit 2
        ;;
esac

if [ "${CCAIRGAP_ENTRYPOINT_DRY_RUN:-}" = "1" ]; then
    dry_run "$DRY_RUN_BRANCH" "${FINAL_CMD[@]}"
    exit 0
fi

if [ "$CODEX_PRINT_STDIN" = "1" ]; then
    set +e
    printf '%s' "$CCAIRGAP_PRINT" | "${FINAL_CMD[@]}"
    rc=${PIPESTATUS[1]}
    set -e
    exit "$rc"
fi

exec -- "${FINAL_CMD[@]}"
