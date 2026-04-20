# Custom Dockerfile

Use a custom Dockerfile when a workflow needs a binary not in the base image. Pass it via `--dockerfile <path>` or `dockerfile: <path>` in `config.yaml` (resolves against the config file's directory — sidecar convention).

## What the base image already has

`docker/Dockerfile` — `FROM node:20-slim` plus:

- `node`, `npm` (from base)
- `@anthropic-ai/claude-code` (installed via `claude.ai/install.sh`, pinned via `CLAUDE_CODE_VERSION` build arg, default `latest`)
- `git`, `git-lfs`, `curl`, `jq`, `rsync`, `ca-certificates`, `less`, `tzdata`, `vim`

That's it. No `python3`, no `pip`, no `uv`, no browsers, no language toolchains, no Docker client, no cloud SDKs.

## Required invariants for a custom Dockerfile

Your custom image must keep four things working or the container won't launch / won't match host file ownership:

1. **The `claude` non-root user exists at `HOST_UID:HOST_GID`.** These are passed as build args at every build. Missing or wrong UID/GID means bind-mounted files show up as root-owned on the host.
2. **`/home/claude/.claude/projects` and `/home/claude/.claude/plugins/cache` exist and are owned by `claude`.** The CLI pre-creates these so Docker doesn't auto-create them as `root:root` before the entrypoint runs.
3. **`/usr/local/bin/ccairgap-entrypoint` exists** — copied from `entrypoint.sh` in the ccairgap package. The `ENTRYPOINT` line must point at it.
4. **Claude Code is installed and on the `claude` user's PATH.** The base uses the native installer (`claude.ai/install.sh`).

Simplest safe pattern: copy the stock Dockerfile and add your extras in the middle. The stock file lives at `<ccairgap-repo>/docker/Dockerfile` (or inside the installed npm package under `docker/`).

## Pattern 1 — Extend the stock recipe

Best when you want to add packages without reasoning about the full image layout. Copy stock → add in the middle.

```dockerfile
FROM node:20-slim

ARG HOST_UID=1000
ARG HOST_GID=1000
ARG CLAUDE_CODE_VERSION=latest

# Stock apt packages, kept as-is.
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
 && rm -rf /var/lib/apt/lists/*

# --- Project additions ---
# Python 3 + pip + uv for hooks / MCP servers written in Python.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir uv
# --- End additions ---

# User setup — do NOT change; bind-mount ownership depends on it.
RUN set -e; \
    if ! getent group ${HOST_GID} > /dev/null; then \
        groupadd -g ${HOST_GID} claude; \
    fi; \
    if ! getent passwd ${HOST_UID} > /dev/null; then \
        useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash claude; \
    else \
        existing=$(getent passwd ${HOST_UID} | cut -d: -f1); \
        usermod -l claude -d /home/claude -m -s /bin/bash -g ${HOST_GID} "$existing" || true; \
    fi; \
    mkdir -p /home/claude && chown -R ${HOST_UID}:${HOST_GID} /home/claude

USER claude
WORKDIR /home/claude

ENV PATH=/home/claude/.local/bin:$PATH

RUN if [ "${CLAUDE_CODE_VERSION}" = "latest" ]; then \
        curl -fsSL https://claude.ai/install.sh | bash; \
    else \
        curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}"; \
    fi

RUN mkdir -p /home/claude/.claude/projects /home/claude/.claude/plugins/cache

USER root
RUN mkdir -p /run/ccairgap-clipboard \
 && chown ${HOST_UID}:${HOST_GID} /run/ccairgap-clipboard
COPY --chown=claude:claude entrypoint.sh /usr/local/bin/ccairgap-entrypoint
RUN chmod +x /usr/local/bin/ccairgap-entrypoint

USER claude
WORKDIR /home/claude

ENTRYPOINT ["/usr/local/bin/ccairgap-entrypoint"]
```

This requires `entrypoint.sh` to sit next to the Dockerfile. Copy it from the ccairgap package (`<node_modules>/ccairgap/docker/entrypoint.sh` or the repo) into your project's `.ccairgap/` dir. `ccairgap init` scaffolds this for you.

## Pattern 2 — `FROM` the already-built ccairgap image

Shorter, but only works after ccairgap has built the base image at least once. Tag is `ccairgap:<cli-version>-<hash8>` (the hash tracks content of `Dockerfile`+`entrypoint.sh`). Custom Dockerfiles of this shape produce a new tag content-addressed from your Dockerfile hash.

```dockerfile
ARG CCAIRGAP_BASE_TAG
FROM ccairgap:${CCAIRGAP_BASE_TAG}

USER root

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir uv

USER claude
```

Caveat: if the base tag doesn't exist locally (e.g. first run on a new machine), Docker errors. Pattern 1 is portable; Pattern 2 is concise. Pattern 1 is safer for committed config.

## Common add-ons

### Python (hooks, MCP servers, scripts)

```dockerfile
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
 && rm -rf /var/lib/apt/lists/*
```

Add `uv` if scripts use it:
```dockerfile
RUN pip3 install --break-system-packages --no-cache-dir uv
```

`--break-system-packages` on `node:20-slim` (Debian-based) sidesteps PEP 668. For a dedicated venv instead, `ENV PATH=/opt/venv/bin:$PATH` + `python3 -m venv /opt/venv`.

### Playwright

Playwright needs both the npm package and system libs for the browser. The `mcr.microsoft.com/playwright` images exist, but switching base is a bigger change; here's the apt path on the stock base:

```dockerfile
# Chromium deps — subset of what `npx playwright install-deps` adds.
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
      libdbus-1-3 libxkbcommon0 libx11-6 libxcomposite1 libxdamage1 \
      libxext6 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g playwright
RUN npx playwright install chromium   # browsers land in /home/claude/.cache/ms-playwright if done as `claude`
```

Do `npx playwright install` **after** the user switch (`USER claude`) so browsers land in the `claude` user's cache, not root's.

### Rust

```dockerfile
ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
  | sh -s -- -y --default-toolchain stable --no-modify-path
```

Combine with `--mount target` for cargo build cache.

### Go

```dockerfile
ENV GO_VERSION=1.22.3
RUN curl -sSL https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz | tar -C /usr/local -xz
ENV PATH=/usr/local/go/bin:/home/claude/go/bin:$PATH
```

### Cloud / dev tool binaries (`gcloud`, `aws`, `kubectl`, `terraform`)

Per-tool install instructions; none of these are tiny. Add the specific one you need, not "just in case." A hook that references `aws` but never fires is still worth installing — it keeps hook enablement honest.

### Docker CLI (for MCP servers that shell out to docker)

Installing the Docker CLI inside the container is fine. **Do not** mount `/var/run/docker.sock` to make it reach the host daemon — that escapes the sandbox. If an MCP needs `docker run`, the honest answer is "that needs the host docker daemon; running it inside ccairgap breaks the sandbox — either skip this MCP, or use it from the host Claude, not the airgapped one."

## Pinning Claude Code version

Default is `latest` at build time, which drifts. Pin via `docker-build-arg`:

```yaml
docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"
```

Or environment variable on the host: `CCAIRGAP_CC_VERSION=1.2.3`. Or CLI: `--docker-build-arg CLAUDE_CODE_VERSION=1.2.3`.

## Rebuild semantics

- Built-in image tag: `ccairgap:<cli-version>-<sha256(Dockerfile+entrypoint.sh)[:8]>`.
- Custom image tag: `ccairgap:custom-<sha256(dockerfile)[:12]>`. Content-addressed.
- Rebuild triggers: tag missing locally, `--rebuild` passed, or Dockerfile content changed (hash differs).
- Image age is never auto-rebuilt. `ccairgap doctor` warns if > 14 days old.

## When NOT to write a custom Dockerfile

A Dockerfile is for binaries and libraries that must be present inside the container. Don't reach for it when the actual need is:

- **Extra env vars** → `--docker-run-arg "-e NAME"`, not a Dockerfile `ENV`.
- **A port exposed** → `--docker-run-arg "-p 8080:8080"`.
- **`node_modules` or a language cache preserved** → `--mount <dir>`.

Runtime knobs (ports, networks, env vars) are `docker-run-arg` territory. See [docker-run-args.md](docker-run-args.md).
