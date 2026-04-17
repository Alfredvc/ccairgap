FROM node:20-slim

ARG HOST_UID=1000
ARG HOST_GID=1000
ARG CLAUDE_CODE_VERSION=latest

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      git-lfs \
      curl \
      jq \
      rsync \
      ca-certificates \
      less \
      vim \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

RUN set -e; \
    if ! getent group ${HOST_GID} > /dev/null; then \
        groupadd -g ${HOST_GID} claude; \
    fi; \
    if ! getent passwd ${HOST_UID} > /dev/null; then \
        useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash claude; \
    else \
        existing=$(getent passwd ${HOST_UID} | cut -d: -f1); \
        usermod -l claude -d /home/claude -m -s /bin/bash "$existing" || true; \
    fi; \
    mkdir -p /home/claude && chown -R ${HOST_UID}:${HOST_GID} /home/claude

# Pre-create bind-mount target dirs so Docker doesn't auto-create them as root:root
# before the entrypoint runs. Matches container paths:
#   /home/claude/.claude/projects       <- $SESSION/transcripts (rw)
#   /home/claude/.claude/plugins/cache  <- ~/.claude/plugins/cache (ro)
RUN mkdir -p /home/claude/.claude/projects /home/claude/.claude/plugins/cache \
 && chown -R ${HOST_UID}:${HOST_GID} /home/claude

COPY --chown=claude:claude entrypoint.sh /usr/local/bin/claude-airgap-entrypoint
RUN chmod +x /usr/local/bin/claude-airgap-entrypoint

USER claude
WORKDIR /home/claude

ENTRYPOINT ["/usr/local/bin/claude-airgap-entrypoint"]
