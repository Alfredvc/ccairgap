FROM node:20-slim
ARG HOST_UID=1000
ARG HOST_GID=1000
RUN apt-get update && apt-get install -y --no-install-recommends git rsync jq ca-certificates && rm -rf /var/lib/apt/lists/*
# Tolerate pre-existing GID/UID (e.g. macOS staff=20 collides with node:20-slim's staff group).
# Same pattern as docker/Dockerfile.
RUN set -e; \
    if ! getent group ${HOST_GID} > /dev/null; then \
        groupadd -g ${HOST_GID} claude; \
    fi; \
    if ! getent passwd ${HOST_UID} > /dev/null; then \
        useradd -m -u ${HOST_UID} -g ${HOST_GID} claude; \
    else \
        existing=$(getent passwd ${HOST_UID} | cut -d: -f1); \
        usermod -l claude -d /home/claude -m -g ${HOST_GID} "$existing" || true; \
    fi; \
    mkdir -p /home/claude && chown -R ${HOST_UID}:${HOST_GID} /home/claude
ENV HOME=/home/claude
ENV PATH=/home/claude/.local/bin:$PATH
RUN mkdir -p \
      /home/claude/.local/bin \
      /home/claude/.claude/projects \
      /home/claude/.claude/plugins/cache \
      /home/claude/.codex/sessions \
 && printf '%s\n' '#!/bin/sh' 'echo fake claude "$@"' > /home/claude/.local/bin/claude \
 && printf '%s\n' '#!/bin/sh' 'echo codex-cli 0.130.0' > /home/claude/.local/bin/codex \
 && chmod +x /home/claude/.local/bin/claude /home/claude/.local/bin/codex \
 && chmod -R go+rwX /home/claude
RUN printf '%s\n' \
    '#!/usr/bin/env bash' \
    'set -euo pipefail' \
    'HOME_DIR="${HOME:-/home/claude}"' \
    'CLAUDE_DIR="$HOME_DIR/.claude"' \
    'export CODEX_HOME="${CODEX_HOME:-$HOME_DIR/.codex}"' \
    'mkdir -p "$CLAUDE_DIR" "$CODEX_HOME" "$CODEX_HOME/sessions"' \
    'if [ -n "${CCAIRGAP_GIT_USER_NAME:-}" ]; then git config --global user.name "$CCAIRGAP_GIT_USER_NAME"; fi' \
    'if [ -n "${CCAIRGAP_GIT_USER_EMAIL:-}" ]; then git config --global user.email "$CCAIRGAP_GIT_USER_EMAIL"; fi' \
    'CWD="${CCAIRGAP_CWD:-/workspace}"' \
    'mkdir -p "$CWD" && cd "$CWD"' \
    'if [ -n "${CCAIRGAP_TEST_CMD:-}" ]; then exec sh -c "$CCAIRGAP_TEST_CMD"; fi' \
    'ENTRYPOINT_AGENT="${CCAIRGAP_AGENT:-claude}"' \
    'print_command() { local first=1; for token in "$@"; do if [ "$first" -eq 0 ]; then printf " "; fi; printf "%q" "$token"; first=0; done; printf "\n"; }' \
    'dry_run() { local branch="$1"; shift; printf "ccairgap-entrypoint-dry-run\n"; printf "branch=%s\n" "$branch"; printf "cwd=%s\n" "$CWD"; printf "CCAIRGAP_AGENT=%s\n" "$ENTRYPOINT_AGENT"; if [ -n "${CCAIRGAP_PRINT:-}" ]; then printf "CCAIRGAP_PRINT=%s\n" "$CCAIRGAP_PRINT"; fi; printf "CODEX_HOME=%s\n" "$CODEX_HOME"; [ -d "$CLAUDE_DIR" ] && printf "claude_home_ready=1\n" || printf "claude_home_ready=0\n"; [ -d "$CODEX_HOME" ] && printf "codex_home_ready=1\n" || printf "codex_home_ready=0\n"; [ -d "$CODEX_HOME/sessions" ] && printf "codex_sessions_ready=1\n" || printf "codex_sessions_ready=0\n"; printf "command="; print_command "$@"; }' \
    'case "$ENTRYPOINT_AGENT" in' \
    '  claude) if [ -n "${CCAIRGAP_PRINT:-}" ]; then FINAL_CMD=(claude --dangerously-skip-permissions "$@" -p "$CCAIRGAP_PRINT"); else FINAL_CMD=(claude --dangerously-skip-permissions "$@"); fi ;;' \
    '  codex) if [ -n "${CCAIRGAP_PRINT:-}" ]; then FINAL_CMD=(codex exec --dangerously-bypass-approvals-and-sandbox --cd "$CWD" "$@" "$CCAIRGAP_PRINT"); else FINAL_CMD=(codex --dangerously-bypass-approvals-and-sandbox --cd "$CWD" "$@"); fi ;;' \
    '  *) echo "ccairgap: unsupported CCAIRGAP_AGENT: $ENTRYPOINT_AGENT" >&2; exit 2 ;;' \
    'esac' \
    'if [ "${CCAIRGAP_ENTRYPOINT_DRY_RUN:-}" = "1" ]; then dry_run "$ENTRYPOINT_AGENT" "${FINAL_CMD[@]}"; exit 0; fi' \
    'exec "${FINAL_CMD[@]}"' \
    > /entrypoint.sh \
 && chmod +x /entrypoint.sh
USER claude
ENTRYPOINT ["/entrypoint.sh"]
