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

## Default extension pattern

`ccairgap init` writes a minimal extension Dockerfile:

```dockerfile
FROM ghcr.io/alfredvc/ccairgap:<cli-version>-<hash8>
```

The tag is the same deterministic image tag the CLI would pull for the bundled image. Add only project-specific packages or files below that `FROM` line:

```dockerfile
FROM ghcr.io/alfredvc/ccairgap:<cli-version>-<hash8>

USER root

RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
 && rm -rf /var/lib/apt/lists/*

RUN pip3 install --break-system-packages --no-cache-dir uv
```

This keeps the ccairgap entrypoint, runtime user model, agent CLIs, and mount target layout inherited from the published image. `docker build` pulls the base image if it is not already present locally, then builds your `ccairgap:custom-<hash>` image on top.

## Required invariants for replacement Dockerfiles

If you inherit from the published image and only add packages, these are already satisfied. If you replace the base image or override entrypoint/user/home behavior, your custom image must keep four things working or the container won't launch / won't match host file ownership:

1. **`/home/claude` is writable for any runtime UID.** The CLI launches the container with `docker run --user $(id -u):$(id -g)`, and the runtime UID needs to read+execute everything under `$HOME` and create new files there. The bundled Dockerfile achieves this with `chmod -R go+rwX /home/claude` near the end. Don't add a final `USER claude` directive — it's overridden by `--user`, but a stale directive is misleading.
2. **Agent mount targets exist with permissive perms.** The image must pre-create `/home/claude/.claude/projects`, `/home/claude/.claude/plugins/cache`, `/home/claude/.codex`, and `/home/claude/.codex/sessions`. They must be traversable by the runtime UID.
3. **`/usr/local/bin/ccairgap-entrypoint` exists** — copied from `entrypoint.sh` in the ccairgap package. The `ENTRYPOINT` line must point at it.
4. **Both agent CLIs are installed and on the runtime PATH.** Claude Code is installed via `claude.ai/install.sh` in the bundled Dockerfile. Codex is installed from the npm package with `CODEX_VERSION`. Claude remains the default selected agent; Codex runtime launch is still staged until later implementation chunks.

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

Default is `latest` at build time for the bundled Dockerfile, which drifts. Pin via `docker-build-arg` when you are using the bundled Dockerfile directly:

```yaml
docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"
```

Or environment variable on the host: `CCAIRGAP_CC_VERSION=1.2.3`. Or CLI: `--docker-build-arg CLAUDE_CODE_VERSION=1.2.3`.

For an extension Dockerfile generated by `ccairgap init`, the agent versions are inherited from the `FROM ghcr.io/alfredvc/ccairgap:<tag>` base image. Change that base image tag to move to a different prebuilt ccairgap image.

## Pinning Codex version

The bundled Dockerfile exposes `CODEX_VERSION`, defaulting to the supported baseline `0.130.0`:

```yaml
docker-build-arg:
  CODEX_VERSION: "0.130.0"
```

Exact unsupported Codex pins are rejected by the image-version policy before launch work in the Codex runtime chunks that consume it. Non-exact inputs such as dist-tags require runtime image contract inspection because the installed version is only known after build or pull. Extension Dockerfiles inherit the Codex version from their `FROM` image.

## Rebuild semantics

- Built-in image tag: `ccairgap:<cli-version>-<sha256(Dockerfile+entrypoint.sh)[:8]>`.
- Custom image tag: `ccairgap:custom-<sha256(dockerfile)[:12]>`. Content-addressed.
- Source order on launch: local image with the computed tag → registry pull from `ghcr.io/alfredvc/ccairgap:<tag>` (default-Dockerfile only) → local build. `--rebuild` skips the first two steps and forces a build. Custom Dockerfiles (`--dockerfile`) produce a local custom image; when they `FROM ghcr.io/alfredvc/ccairgap:<tag>`, Docker pulls that base image during the build if needed.
- Override the registry repo with `CCAIRGAP_REGISTRY=<host>/<owner>/<repo>` (e.g. for forks or private mirrors).
- Image age is never auto-rebuilt. `ccairgap doctor` warns if > 14 days old.

## When NOT to write a custom Dockerfile

A Dockerfile is for binaries and libraries that must be present inside the container. Don't reach for it when the actual need is:

- **Extra env vars** → `--docker-run-arg "-e NAME"`, not a Dockerfile `ENV`.
- **A port exposed** → `--docker-run-arg "-p 8080:8080"`.
- **`node_modules` or a language cache preserved** → `--mount <dir>`.

Runtime knobs (ports, networks, env vars) are `docker-run-arg` territory. See [docker-run-args.md](docker-run-args.md).
