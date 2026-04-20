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
        usermod -l claude -d /home/claude -m "$existing" || true; \
    fi; \
    mkdir -p /home/claude && chown -R ${HOST_UID}:${HOST_GID} /home/claude
# Minimal inline entrypoint. Tier2 only exercises the CCAIRGAP_TEST_CMD
# backdoor, so we don't need the real entrypoint's rsync/creds/resume logic —
# just cd to CCAIRGAP_CWD and exec the test command. Inlined so the build
# context (dirname of this Dockerfile, i.e. e2e/fixtures/) doesn't need to
# reach up to docker/entrypoint.sh.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -eu' \
    'if [ -n "${CCAIRGAP_GIT_USER_NAME:-}" ]; then git config --global user.name "$CCAIRGAP_GIT_USER_NAME"; fi' \
    'if [ -n "${CCAIRGAP_GIT_USER_EMAIL:-}" ]; then git config --global user.email "$CCAIRGAP_GIT_USER_EMAIL"; fi' \
    'CWD="${CCAIRGAP_CWD:-/workspace}"' \
    'mkdir -p "$CWD" && cd "$CWD"' \
    'if [ -n "${CCAIRGAP_TEST_CMD:-}" ]; then exec sh -c "$CCAIRGAP_TEST_CMD"; fi' \
    'echo "fake entrypoint: CCAIRGAP_TEST_CMD not set" >&2; exit 1' \
    > /entrypoint.sh \
 && chmod +x /entrypoint.sh
USER claude
ENTRYPOINT ["/entrypoint.sh"]
