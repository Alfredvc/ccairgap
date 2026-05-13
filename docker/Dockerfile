FROM node:24-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=0.130.0

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      git \
      git-lfs \
      curl \
      jq \
      rsync \
      ca-certificates \
      less \
      tzdata \
      vim \
      python3 \
      python3-pip \
      python3-venv \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@${CODEX_VERSION}

# Rename baked node user/group → claude. Cosmetic: at runtime the CLI
# overrides via `docker run --user $(id -u):$(id -g)` and bind-mounts a
# session-generated /etc/passwd + /etc/group, so the baked entry is never
# the one libc resolves. Keeping the build-time user keeps /home/claude
# meaningful and lets us run the claude install step as a non-root user.
RUN groupmod -n claude node \
 && usermod -l claude -d /home/claude -m -s /bin/bash node

ENV HOME=/home/claude
ENV PATH=/home/claude/.local/bin:$PATH

USER claude
WORKDIR /home/claude

RUN if [ "${CLAUDE_CODE_VERSION}" = "latest" ]; then \
        curl -fsSL https://claude.ai/install.sh | bash; \
    else \
        curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}"; \
    fi

# Pre-create bind-mount target dirs so Docker doesn't auto-create them as
# root:root before the entrypoint runs. Matches container paths:
#   /home/claude/.claude/projects       <- $SESSION/transcripts (rw)
#   /home/claude/.claude/plugins/cache  <- ~/.claude/plugins/cache (ro)
#   /home/claude/.codex                 <- future $SESSION/codex-home (rw)
#   /home/claude/.codex/sessions        <- future $SESSION/codex-sessions (rw)
RUN mkdir -p \
      /home/claude/.claude/projects \
      /home/claude/.claude/plugins/cache \
      /home/claude/.codex/sessions

# Make /home/claude writable for any runtime UID. The CLI launches with
# --user $(id -u):$(id -g), and that UID needs to write inside $HOME
# without owning it. `go+rwX` (capital X) gives group+other rwx on dirs
# and rw on regular files while preserving the executable bit on
# already-executable files (e.g. /home/claude/.local/bin/claude). See
# docs/SPEC.md §"Container UID portability".
USER root
RUN chmod -R go+rwX /home/claude

# Clipboard bridge mount target. Source is host $SESSION/clipboard-bridge
# (created by the CLI as the host user). When mounted, the bind takes
# over and the perms below don't matter; when not mounted (clipboard
# mode off), nothing reads or writes here so 1777 is harmless.
RUN mkdir -p /run/ccairgap-clipboard \
 && chmod 1777 /run/ccairgap-clipboard

COPY entrypoint.sh /usr/local/bin/ccairgap-entrypoint
RUN chmod 0755 /usr/local/bin/ccairgap-entrypoint

# No final USER directive: container runs as whatever UID the CLI passes
# via --user. WORKDIR + HOME (set above) work for any UID because of the
# go+rwX chmod.
WORKDIR /home/claude
ENTRYPOINT ["/usr/local/bin/ccairgap-entrypoint"]
