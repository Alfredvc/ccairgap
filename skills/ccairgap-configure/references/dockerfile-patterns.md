<!--
  GENERATED FILE — do not edit.
  Source: docs/dockerfile.md
  Regenerate with: scripts/sync-skill-assets.sh
-->

# Custom Dockerfile

Use a custom Dockerfile when a workflow needs a binary not in the base image. Pass it via `--dockerfile <path>` or `dockerfile: <path>` in `config.yaml` (resolves against the config file's directory — sidecar convention).

## What the base image already has

`docker/Dockerfile` — `FROM node:24-slim` plus:

- `node`, `npm` (from base)
- `@anthropic-ai/claude-code` (installed via `claude.ai/install.sh`, pinned via `CLAUDE_CODE_VERSION` build arg, default `latest`)
- `@openai/codex` (installed with `npm install -g @openai/codex@${CODEX_VERSION}`, default `CODEX_VERSION=0.130.0`)
- `git`, `git-lfs`, `curl`, `jq`, `rsync`, `ca-certificates`, `less`, `tzdata`, `vim`
- `python3`, `python3-pip`, `python3-venv`

No `uv`, no browsers, no other language toolchains, no Docker client, no cloud SDKs, no `build-essential` (~200MB; opt in via custom Dockerfile if `pip install` of native-dep packages is needed).

## Required invariants for a custom Dockerfile

Your custom image must keep four things working or the container won't launch / won't match host file ownership:

1. **`/home/claude` is writable for any runtime UID.** The CLI launches the container with `docker run --user $(id -u):$(id -g)`, and the runtime UID needs to read+execute everything under `$HOME` and create new files there. The bundled Dockerfile achieves this with `chmod -R go+rwX /home/claude` near the end. Don't add a final `USER claude` directive — it's overridden by `--user`, but a stale directive is misleading.
2. **Agent mount targets exist with permissive perms.** The image must pre-create `/home/claude/.claude/projects`, `/home/claude/.claude/plugins/cache`, `/home/claude/.codex`, and `/home/claude/.codex/sessions`. They must be traversable by the runtime UID.
3. **`/usr/local/bin/ccairgap-entrypoint` exists** — copied from `entrypoint.sh` in the ccairgap package. The `ENTRYPOINT` line must point at it.
4. **Both agent CLIs are installed and on the runtime PATH.** Claude Code is installed via `claude.ai/install.sh` in the bundled Dockerfile. Codex is installed from the npm package with `CODEX_VERSION`. Claude remains the default selected agent; Codex runtime launch is still staged until later implementation chunks.

The CLI also bind-mounts a per-session `/etc/passwd` and `/etc/group` RO so libc lookups for the runtime UID resolve to "claude" (Node's `os.userInfo()`, git's GECOS read, etc.). You don't have to do anything for this — it happens regardless of which Dockerfile you use — but be aware that any baked `/etc/passwd` modifications are overlaid at runtime.

Simplest safe pattern: copy the stock Dockerfile and add your extras in the middle. The stock file lives at `<ccairgap-repo>/docker/Dockerfile` (or inside the installed npm package under `docker/`).

## Pattern 1 — Extend the stock recipe

Best when you want to add packages without reasoning about the full image layout. Copy stock → add in the middle.

```dockerfile
FROM node:24-slim

ARG CLAUDE_CODE_VERSION=latest
ARG CODEX_VERSION=0.130.0

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
      python3 \
      python3-pip \
      python3-venv \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g @openai/codex@${CODEX_VERSION}

# --- Project additions ---
RUN pip3 install --break-system-packages --no-cache-dir uv
# --- End additions ---

# node:*-slim ships a `node` user at UID/GID 1000; rename in place. The
# user is cosmetic at runtime — the CLI launches with `--user $(id -u):$(id -g)`,
# overriding it. See docs/SPEC.md §"Container UID portability".
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
RUN mkdir -p \
      /home/claude/.claude/projects \
      /home/claude/.claude/plugins/cache \
      /home/claude/.codex/sessions

# Make /home/claude writable for any runtime UID. The CLI passes
# --user $(id -u):$(id -g); that UID needs to read+execute baked content
# and create new files inside $HOME without owning it. Capital `X`
# preserves the executable bit on already-executable files.
USER root
RUN chmod -R go+rwX /home/claude

RUN mkdir -p /run/ccairgap-clipboard \
 && chmod 1777 /run/ccairgap-clipboard
COPY entrypoint.sh /usr/local/bin/ccairgap-entrypoint
RUN chmod 0755 /usr/local/bin/ccairgap-entrypoint

# No final USER directive — `docker run --user` from the CLI sets it.
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

### Python build deps (compiling native pip packages)

`python3` + `python3-pip` + `python3-venv` ship in the base image. `pip install <pkg-with-C-extensions>` will fail without a compiler — add it explicitly:

```dockerfile
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      python3-dev \
 && rm -rf /var/lib/apt/lists/*
```

Add `uv` if scripts use it:
```dockerfile
RUN pip3 install --break-system-packages --no-cache-dir uv
```

`--break-system-packages` on `node:24-slim` (Debian-based) sidesteps PEP 668. For a dedicated venv instead, `ENV PATH=/opt/venv/bin:$PATH` + `python3 -m venv /opt/venv`.

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

## Pinning Codex version

The bundled Dockerfile exposes `CODEX_VERSION`, defaulting to the supported baseline `0.130.0`:

```yaml
docker-build-arg:
  CODEX_VERSION: "0.130.0"
```

Exact unsupported Codex pins are rejected by the image-version policy before launch work in the Codex runtime chunks that consume it. Non-exact inputs such as dist-tags require runtime image contract inspection because the installed version is only known after build or pull.

## Rebuild semantics

- Built-in image tag: `ccairgap:<cli-version>-<sha256(Dockerfile+entrypoint.sh)[:8]>`.
- Custom image tag: `ccairgap:custom-<sha256(dockerfile)[:12]>`. Content-addressed.
- Source order on launch: local image with the computed tag → registry pull from `ghcr.io/alfredvc/ccairgap:<tag>` (default-Dockerfile only) → local build. `--rebuild` skips the first two steps and forces a build. Custom Dockerfiles (`--dockerfile`) skip registry, so first launch always builds locally.
- Override the registry repo with `CCAIRGAP_REGISTRY=<host>/<owner>/<repo>` (e.g. for forks or private mirrors).
- Image age is never auto-rebuilt. `ccairgap doctor` warns if > 14 days old.

## When NOT to write a custom Dockerfile

A Dockerfile is for binaries and libraries that must be present inside the container. Don't reach for it when the actual need is:

- **Extra env vars** → `--docker-run-arg "-e NAME"`, not a Dockerfile `ENV`.
- **A port exposed** → `--docker-run-arg "-p 8080:8080"`.
- **`node_modules` or a language cache preserved** → `--mount <dir>`.

Runtime knobs (ports, networks, env vars) are `docker-run-arg` territory. See [docker-run-args.md](docker-run-args.md).
