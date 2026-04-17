# Gathering context (Phase 1)

Before recommending config, probe the host. Don't ask the user questions you can answer yourself with a tool call.

## Minimum probe

Run these in parallel when you can.

### Git repo shape

```bash
git rev-parse --show-toplevel          # workspace repo root
git config --get user.name             # for identity passthrough sanity check
git config --get user.email
git status --porcelain                 # is there in-progress work?
```

Read `<repo>/.gitmodules` if present. Submodules are a known limitation — warn the user they won't initialize inside the container from private remotes.

### Project type

Look for manifests at the repo root:

| File | Language / toolchain | Likely artifact dirs |
|------|----------------------|----------------------|
| `package.json` | Node | `node_modules/`, `dist/`, `.next/`, `build/` |
| `pyproject.toml`, `requirements.txt`, `Pipfile` | Python | `.venv/`, `__pycache__/`, `.mypy_cache/` |
| `Cargo.toml` | Rust | `target/` |
| `go.mod` | Go | none mandatory; module cache is `$GOPATH/pkg/mod` |
| `Gemfile` | Ruby | `vendor/bundle/` |
| `pom.xml`, `build.gradle` | JVM | `target/`, `build/`, `.gradle/` |
| `deno.json` | Deno | `.deno/` |
| `bun.lockb` | Bun | `node_modules/` |

Read the manifest if it exists — `scripts` / `dependencies` / `devDependencies` hint at tools that will be shelled out (Playwright, Puppeteer, Prisma, Cypress, etc.).

### Claude setup

```bash
ls -la ~/.claude/
cat ~/.claude/settings.json       # if it exists
cat ~/.claude.json                # mcpServers block
```

Also check project-scoped settings:

```bash
cat <repo>/.claude/settings.json
cat <repo>/.claude/settings.local.json
```

Extract:

- **Hooks** — every entry in `hooks.*` arrays has a `command` string. Record them; these will be filtered by `--hook-enable` globs. A hook referencing a host-only path (`~/scripts/...`, `/opt/homebrew/bin/...`) is a tell the user will need to either enable + install in Dockerfile, or leave disabled.

  **Use `ccairgap hooks` instead of hand-walking sources.** It enumerates every entry ccairgap would see at launch across all three sources (user settings, each enabled plugin's `hooks.json`, project `.claude/settings.json[.local]` for `--repo` + every `--extra-repo`) as JSON — one object per entry with `source`, `sourcePath`, `event`, `matcher`, `command`. Pass `--repo` / `--extra-repo` that match the launch you're configuring, or run inside the target repo and defaults match. This is the canonical way to discover hooks — reaching for `jq` on individual files will miss plugin hooks, which is the most common source of "it worked with the skill but missed half my hooks".
- **MCP servers** — `mcpServers` entries in `~/.claude.json` (and project `.claude.json` if present). Each has a `command` (binary) and optional `args`. If the command isn't in the base image's PATH, it needs either a Dockerfile extension or it won't work inside the container.
- **Plugin marketplaces** — `extraKnownMarketplaces` entries with `source.source: "directory"` or `"file"` are host paths that ccairgap auto-discovers and RO-mounts. User doesn't have to configure these, but it's worth noting they exist.
- **Status line** — `statusLine.command` is a hook-like entry; filtered the same way.

### Binary dependencies inside the container

Base image provides: `node`, `npm`, `git`, `git-lfs`, `curl`, `jq`, `rsync`, `ca-certificates`, `less`, `vim`, `@anthropic-ai/claude-code`.

Anything else the workflow needs — `python3`, `pip`, `uv`, `cargo`, `go`, `playwright`, `docker` CLI, cloud SDKs, language-specific package managers — needs a custom Dockerfile entry. Build a list by looking at:

- MCP `command` fields (often `uv`, `npx`, `docker`, `python3`).
- Hook `command` fields (same).
- `package.json` `scripts` (hint at what the workflow invokes).
- `.tool-versions` / `.nvmrc` / `.python-version` (version pins the user likely wants).
- CI config (`.github/workflows/*.yml`) — whatever CI does, the container probably needs too.

### Network needs

- Does the workflow launch a dev server? Look for `dev`, `start`, `serve` scripts. Default ports: Next.js 3000, Vite 5173, Rails 3000, FastAPI 8000, Django 8000, Nuxt 3000, Astro 4321, Storybook 6006.
- Does the project connect to localhost services (DB, Redis, Elasticsearch)? Container's default bridge network doesn't see host localhost. Options: `--add-host=host.docker.internal:host-gateway` via `--docker-run-arg`, or attach to a user-created docker network both containers share (`--docker-run-arg "--network <name>"`).
- Does a hook / MCP need an env var (API keys)? `--docker-run-arg "-e NAME=$VAR"` or `-e NAME` to inherit from the host environment.

### Trust decision on artifact dirs

For each candidate artifact dir, you need the user's explicit choice. Default recommendation depends on use case:

| Dir | Default recommendation | Reasoning |
|-----|-----------------------|-----------|
| `node_modules` | `--mount` | Regenerating it is slow; most users trust the container not to nuke it. |
| `.venv` | `--mount` | Same as above. |
| `target/` (Rust) | `--mount` | Compiles are very slow; cache matters a lot. |
| `dist/`, `build/`, `.next/` | `--sync` | User wants the build output after the session without letting the container touch the original. |
| Local app data (`.cache/`, `.data/`) | `--sync` or `--cp` — ask | Depends on whether changes should be kept. |

Ask the user explicitly when it's ambiguous; surface the tradeoff.

## Align before producing

After probing, state what you found and your proposed config. Let the user redirect before you write anything.

Good framing:

> Found: Node/TypeScript project at `~/src/foo`. `node_modules` is 1.2 GB. Your `~/.claude/settings.json` has two hooks (one `python3` auto-approve, one `bash` statusline). MCP servers: `grafana` (uses `docker` — won't work in sandbox without Dockerfile extension), `puppeteer-mcp` (uses `npx`, should work). No obvious dev server script.
>
> Proposed:
> - `config.yaml`: `--mount node_modules`, `--hook-enable 'python3 *'`, `--hook-enable 'bash ~/.claude/statusline.sh'`.
> - No custom Dockerfile — disabling the grafana MCP is easier than adding docker-in-docker.
> - No docker-run-args needed.
>
> Does that match what you want, or do you actually need grafana MCP working?

Be specific about what you didn't add and why.
