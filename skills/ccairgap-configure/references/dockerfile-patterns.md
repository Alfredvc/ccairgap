<!--
  GENERATED FILE — do not edit.
  Source: docs/dockerfile.md
  Regenerate with: scripts/sync-skill-assets.sh
-->

# Custom Dockerfile

Use a custom Dockerfile when a workflow needs a binary not in the base image. Pass it via `--dockerfile <path>` or `dockerfile: <path>` in `config.yaml` (resolves against the config file's directory — sidecar convention).

## What the default image already has

`docker/Dockerfile` — `FROM node:24-slim` plus:

- `node`, `npm` (from base)
- `@anthropic-ai/claude-code` (installed via `claude.ai/install.sh`, pinned via exact `CLAUDE_CODE_VERSION` build arg)
- `@openai/codex` (installed with `npm install -g @openai/codex@${CODEX_VERSION}`, pinned via exact `CODEX_VERSION` build arg)
- `git`, `git-lfs`, `curl`, `jq`, `rsync`, `ca-certificates`, `less`, `tzdata`, `vim`
- `python3`, `python3-pip`, `python3-venv`

No `uv`, no browsers, no other language toolchains, no Docker client, no cloud SDKs, no `build-essential` (~200MB; opt in via custom Dockerfile if `pip install` of native-dep packages is needed).

Generated extension Dockerfiles inherit from ccairgap's runtime stage, which has the OS packages, UID model, entrypoint, and mount target layout. The generated file then installs Claude Code and Codex at the end so project package layers can stay cached across agent upgrades.

## Default extension pattern

`ccairgap init` writes a minimal extension Dockerfile:

```dockerfile
ARG CCAIRGAP_RUNTIME_BASE_IMAGE=ccairgap:runtime-base-required
FROM ${CCAIRGAP_RUNTIME_BASE_IMAGE}

# Add project-specific image changes above the agent install block.
# Host Claude Code / Codex upgrades only invalidate the layers below.

ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION

RUN test -n "$CLAUDE_CODE_VERSION" \
 && test -n "$CODEX_VERSION"

RUN npm install -g @openai/codex@${CODEX_VERSION}

USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}"

USER root
RUN chmod -R go+rwX /home/claude \
 && test "$(claude --version | node -e '...')" = "$CLAUDE_CODE_VERSION" \
 && test "$(codex --version | node -e '...')" = "$CODEX_VERSION"
```

`CCAIRGAP_RUNTIME_BASE_IMAGE` is set by ccairgap, not by users. At launch, ccairgap ensures a stable runtime base image exists locally by using the normal local → registry → build flow. The generated Dockerfile installs Claude Code and Codex at the end, after the place where project-specific packages belong. That keeps user package layers cached when only the host agent versions change.

Add project-specific packages above the agent install block:

```dockerfile
ARG CCAIRGAP_RUNTIME_BASE_IMAGE=ccairgap:runtime-base-required
FROM ${CCAIRGAP_RUNTIME_BASE_IMAGE}

USER root

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir uv

ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION

RUN test -n "$CLAUDE_CODE_VERSION" \
 && test -n "$CODEX_VERSION"

RUN npm install -g @openai/codex@${CODEX_VERSION}

USER claude
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}"

USER root
RUN chmod -R go+rwX /home/claude \
 && test "$(claude --version | node -e '...')" = "$CLAUDE_CODE_VERSION" \
 && test "$(codex --version | node -e '...')" = "$CODEX_VERSION"
```

This keeps the ccairgap entrypoint, runtime user model, and mount target layout inherited from the managed runtime base image. When your host Claude Code or Codex version changes, the runtime base and project package layers stay cached; only the final agent install layers rebuild. You do not need to add `CLAUDE_CODE_VERSION` or `CODEX_VERSION` build args for normal host-agent upgrades.

## Required invariants for replacement Dockerfiles

If you inherit from the published image and only add packages, these are already satisfied. If you replace the base image or override entrypoint/user/home behavior, your custom image must keep five things working or the container won't launch / won't match host file ownership:

1. **`/home/claude` is writable for any runtime UID.** The CLI launches the container with `docker run --user $(id -u):$(id -g)`, and the runtime UID needs to read+execute everything under `$HOME` and create new files there. The bundled Dockerfile achieves this with `chmod -R go+rwX /home/claude` near the end. Don't add a final `USER claude` directive — it's overridden by `--user`, but a stale directive is misleading.
2. **Agent mount targets exist with permissive perms.** The image must pre-create `/home/claude/.claude/projects`, `/home/claude/.claude/plugins/cache`, `/home/claude/.codex`, and `/home/claude/.codex/sessions`. They must be traversable by the runtime UID.
3. **`/usr/local/bin/ccairgap-entrypoint` exists** — copied from `entrypoint.sh` in the ccairgap package. The `ENTRYPOINT` line must point at it.
4. **`node` is on the runtime PATH and the entrypoint is current, if you use a [network policy](network.md).** The entrypoint starts the forwarder with `node` and exits when it cannot. An old copy of the entrypoint starts no forwarder, so the agent's requests fail with connection refused. The agent stays on `--network none` in both cases.
5. **Both agent CLIs are installed and on the runtime PATH.** Claude Code is installed via `claude.ai/install.sh` in the bundled Dockerfile. Codex is installed from the npm package with `CODEX_VERSION`. Claude remains the default selected agent, and Codex is launched when selected with `--agent codex` or `agent: codex`.

The CLI also bind-mounts a per-session `/etc/passwd` and `/etc/group` RO so libc lookups for the runtime UID resolve to "claude" (Node's `os.userInfo()`, git's GECOS read, etc.). You don't have to do anything for this — it happens regardless of which Dockerfile you use — but be aware that any baked `/etc/passwd` modifications are overlaid at runtime.

The full stock Dockerfile remains in the npm package under `docker/Dockerfile` for auditing and advanced replacement builds, but it is not the recommended customization surface.

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

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g playwright \
 && npx playwright install chromium \
 && chmod -R go+rwX /ms-playwright
```

`PLAYWRIGHT_BROWSERS_PATH` keeps the browser cache outside root's home, and `go+rwX` makes it readable by the runtime UID passed by the CLI.

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

By default, ccairgap resolves `latest` to the exact host `claude --version` before image work begins. `latest` is not an image identity and is never passed to the bundled Dockerfile. If the host has no `claude` binary, ccairgap uses the `CLAUDE_CODE_VERSION` pin from the bundled `docker/agent-versions.env` instead, so a host with only Codex still launches. Launch fails only when neither the host nor the pin gives an exact version. Most users should omit this setting so the container follows the host version automatically. Pin via `docker-build-arg` only when you intentionally want the container to differ from the host:

```yaml
docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"
```

Or environment variable on the host: `CCAIRGAP_CC_VERSION=1.2.3`. Or CLI: `--docker-build-arg CLAUDE_CODE_VERSION=1.2.3`.

For an extension Dockerfile generated by `ccairgap init`, leave `ARG CCAIRGAP_RUNTIME_BASE_IMAGE=ccairgap:runtime-base-required` / `FROM ${CCAIRGAP_RUNTIME_BASE_IMAGE}` in place. ccairgap fills it with the managed runtime base image tag. Keep project-specific package installs above the agent install block.

## Pinning Codex version

By default, ccairgap resolves `latest` to the exact host `codex --version` before image work begins. `latest` is not an image identity and is never passed to the bundled Dockerfile. If the host has no `codex` binary, ccairgap uses the `CODEX_VERSION` pin from the bundled `docker/agent-versions.env` instead, so a host with only Claude Code still launches. Launch fails only when neither the host nor the pin gives an exact version. Most users should omit this setting so the container follows the host version automatically. Pin via `docker-build-arg` only when you intentionally want the container to differ from the host:

```yaml
docker-build-arg:
  CODEX_VERSION: "1.2.3"
```

Exact Codex pins are validated by the image-version policy before launch. Non-exact inputs such as dist-tags are rejected because ccairgap must know the exact Codex version before it can compute the image tag. Extension Dockerfiles install Codex in the final block and check that it matches the resolved exact version.

## Rebuild semantics

- Built-in image tag: `ccairgap:<cli-version>-<sha256(Dockerfile+entrypoint.sh+exact agent versions)[:8]>`.
- Runtime base image tag: `ccairgap:<cli-version>-runtime-<sha256(runtime-Dockerfile+entrypoint.sh)[:8]>`.
- Custom image tag: `ccairgap:custom-<sha256(dockerfile+exact agent versions+managed base image identity when used)[:12]>`. Content-addressed.
- Source order on launch: local image with the computed tag → registry pull from `ghcr.io/alfredvc/ccairgap:<version>-<hash8>` (default-Dockerfile only) → local build. `--rebuild` skips the first two steps and forces a build. Custom Dockerfiles (`--dockerfile`) produce a local custom image; when they use `ARG CCAIRGAP_RUNTIME_BASE_IMAGE`, ccairgap first ensures the matching runtime base image exists, then passes that local base tag into `docker build`.
- Override the registry repo with `CCAIRGAP_REGISTRY=<host>/<owner>/<repo>` (e.g. for forks or private mirrors).
- Changing the host Claude Code or Codex version changes the resolved image tag, so the next launch builds or pulls that one new image once. The first launch after upgrading to versioned image identity may also build a new image even when an older Dockerfile-content tag already exists.
- Image age is never auto-rebuilt. `ccairgap doctor` warns if > 14 days old.

## When NOT to write a custom Dockerfile

A Dockerfile is for binaries and libraries that must be present inside the container. Don't reach for it when the actual need is:

- **Extra env vars** → `--docker-run-arg "-e NAME"`, not a Dockerfile `ENV`.
- **A port exposed** → `--docker-run-arg "-p 8080:8080"`.
- **`node_modules` or a language cache preserved** → `--mount <dir>`.

Runtime knobs (ports, networks, env vars) are `docker-run-arg` territory. See [docker-run-args.md](docker-run-args.md).
