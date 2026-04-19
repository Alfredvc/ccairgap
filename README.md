<div align="center">

# ccairgap

![ccairgap — walk away, work lands as branches](docs/readme-banner.jpg)

[![CI](https://github.com/alfredvc/ccairgap/actions/workflows/ci.yml/badge.svg)](https://github.com/alfredvc/ccairgap/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ccairgap.svg)](https://www.npmjs.com/package/ccairgap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

</div>

**A sandbox for Claude Code that just works.**

Same config, skills, hooks, and MCP servers as on your host. Full permissions inside. Launches in seconds, even on huge repos. Work lands as new git branches in your repo on exit.

- **Full permissions, contained** — host filesystem physically out of reach.
- **Your Claude** — config, skills, hooks, and MCP servers all inherited.
- **Work lands as branches** — nothing lost if you walk away.
- **Fast on large repos** — shared clone, no full copy.
- **Opt-in hooks and MCP** — disabled by default; enable by glob.
- **Resume any session** — start on host or sandbox, continue on either.

## Why ccairgap?

**vs. running `claude --dangerously-skip-permissions` on your host.** One bad tool call — or one prompt-injected instruction — can touch any file your user account can. ccairgap constrains the writable surface physically: not by rules, but by not mounting those paths.

**vs. using Claude with permission prompts.** Prompts are tedious to babysit, blanket rules risk over-permissioning, and precise rules are hard to write. ccairgap skips the permission layer entirely — the sandbox itself is the layer.

**vs. other Claude sandbox tools.** Most give you a stripped-down Claude. ccairgap gives you yours — fully configured, exactly as it runs on your host.

## Setup

```bash
npm i -g ccairgap
```

**Requirements:** Node ≥ 20, Docker, `git`, and `rsync` on PATH. macOS, Linux, and Windows/WSL2.

**Login:** Run `claude` once on the host — ccairgap inherits the credentials automatically.

**First launch:** Builds the container image (~1–2 min, one-time). Every launch after is seconds.

## Quick start

Run inside any git repo:

```bash
ccairgap
```

Claude opens at your repo root. Common setups:

```bash
# Read-only sibling (e.g. node_modules)
ccairgap --ro node_modules

# Two repos: primary workspace + readable sibling
ccairgap --repo ~/src/foo --extra-repo ~/src/bar

# Hand it a task and walk away
ccairgap -p "add login flow"

# Inside tmux so the session outlives your terminal
tmux new-session -d -s work 'ccairgap -p "add login flow"'

# Resume a host-started session inside the sandbox
ccairgap -r 01234567-89ab-cdef-0123-456789abcdef
```

On exit, Claude's commits land as `ccairgap/<id>` in each repo:

```bash
$ ccairgap -p "add login flow"
# ... Claude works, commits, exits ...
$ git log --oneline ccairgap/fuzzy-otter-a4f1
a3f1b2c Wire auth middleware
b4e2d8f Add login route
```

- **No commits** → no branch created.
- **Commits on a side branch only** → session dir preserved with a warning. Inspect, recover what you need, then `ccairgap discard <id>`.

## Agent Skills

```bash
npx skills add alfredvc/ccairgap
```

## Contents

- [Why ccairgap?](#why-ccairgap)
- [Setup](#setup)
- [Quick start](#quick-start)
- [Agent Skills](#agent-skills)
- [Launch flags](#launch-flags)
- [Hooks](#hooks)
- [MCP servers](#mcp-servers)
- [Raw docker run args](#raw-docker-run-args)
- [Config file](#config-file)
- [Subcommands](#subcommands)
- [Environment variables](#environment-variables)
- [Development](#development)
- [Contributing](#contributing)

## Launch flags

| Flag | Default | Repeatable | Description |
|------|---------|------------|-------------|
| `--config <path>` | `<git-root>/.ccairgap/config.yaml` (fallback: `<git-root>/.config/ccairgap/config.yaml`) | no | YAML config file. |
| `--profile <name>` | — | no | Named config under the canonical dir: `default` = `config.yaml`, any other `<name>` = `<name>.config.yaml` (e.g. `--profile web` → `<git-root>/.ccairgap/web.config.yaml`). Missing profile file is a hard error. Mutually exclusive with `--config`. |
| `--repo <path>` | cwd (if git repo) | no | Host repo exposed as the workspace (container cwd). Cloned `--shared`; branch `ccairgap/<id>` created on exit. |
| `--extra-repo <path>` | — | yes | Additional repo mounted alongside `--repo`. Same clone/branch treatment, but not the workspace. |
| `--ro <path>` | — | yes | Extra read-only bind mount. |
| `--cp <path>` | — | yes | Copy a host path into the session at launch. Container sees it RW; changes discarded on exit. Relative paths resolve against the workspace repo. |
| `--sync <path>` | — | yes | Same copy-in as `--cp`, plus on exit the container-written copy is rsynced to `$CCAIRGAP_HOME/output/<id>/<abs-src>/`. Original host path never written. |
| `--mount <path>` | — | yes | Live RW bind-mount. Container writes go directly to the host path. Opt-in weakening of the host-write invariant. |
| `--base <ref>` | HEAD of each repo | no | Base ref for `ccairgap/<id>`. |
| `--keep-container` | off | no | Omit `docker run --rm` so the container persists for postmortem. |
| `--dockerfile <path>` | bundled | no | Build from a user-supplied Dockerfile. |
| `--docker-build-arg KEY=VAL` | — | yes | Forwarded to `docker build --build-arg`. Use `CLAUDE_CODE_VERSION=<semver>` to pin Claude Code. |
| `--rebuild` | off | no | Force image rebuild. |
| `-p, --print <prompt>` | — | no | `claude -p "<prompt>"` instead of the REPL. |
| `-n, --name <name>` | random `<adj>-<noun>` | no | Session id **prefix**. The CLI always appends a 4-hex suffix; the final id is `<name>-<4hex>`. Drives the session dir, docker container (`ccairgap-<id>`), branch (`ccairgap/<id>`), and Claude's session label (`ccairgap <id>`, rewritten to `[ccairgap] <id>` by the rename hook). Must be a valid git ref component. See notes below. |
| `-r, --resume <session-id>` | — | no | Resume an existing Claude session by UUID inside the sandbox. The CLI copies `~/.claude/projects/<encoded-workspace-cwd>/<uuid>.jsonl` into the session before `docker run`. Works with both host-born and ccairgap-born sessions. Requires a workspace repo. |
| `--hook-enable <glob>` | all disabled | yes | Opt-in a hook by matching its raw `command` string. Wildcard `*`. |
| `--mcp-enable <glob>` | all disabled | yes | Opt-in an MCP server by `name`. Wildcard `*`. |
| `--docker-run-arg <args>` | — | yes | Extra args appended to `docker run`. Shell-quoted. Can weaken isolation. |
| `--no-warn-docker-args` | warnings on | no | Suppress the warning emitted when `--docker-run-arg` contains tokens known to weaken isolation. |
| `--bare` | off | no | Skip config-file discovery and cwd-as-workspace inference. See `docs/SPEC.md` §"Bare mode". |

### Notes on `--name`

- Session label is always `ccairgap <id>`; TUI title is `[ccairgap] <id>`. Without `--name`, `<id>` is `<adj>-<noun>-<4hex>` (random). With `--name foo`, `<id>` is `foo-<4hex>`.
- `--name` supplies only the **prefix**; a 4-hex suffix is always appended (`<name>-<4hex>`), so two launches with the same `--name` never collide on branch, container, or session dir.
- The full `<id>` surfaces in `ccairgap list`, the container name (`ccairgap-<id>`), the branch (`ccairgap/<id>`), and the session directory.
- The two-step rename (label → title) is intentional: the two strings still differ, so Claude Code's hook-dedup fires and the TUI rename effect paints the top-border.
- `--resume <session-id>`: the resumed session uses the new `<id>` as its label — prior display name is not preserved.

## Hooks

Your host hooks are available inside the sandbox — they just need to be explicitly opted in. By default all hooks are disabled because host hook configs typically reference binaries (`afplay`, project-local `python3` scripts, user-installed CLIs) that aren't present in the container and would fail every tool call.

Opt hooks in with `--hook-enable <glob>` or `hooks.enable: [glob, ...]` in config. The glob matches the raw `command` string of each hook entry (wildcard `*`, anchored full match):

```bash
# Enable just the python3 auto-deny / auto-approve hooks
ccairgap --hook-enable 'python3 *'

# Enable two specific commands
ccairgap \
  --hook-enable 'python3 *' \
  --hook-enable 'node /path/to/audit.js'
```

If a hook's command references a binary that isn't in your container image, opting it in still fails at invocation — extend the Dockerfile (`--dockerfile`) to include the binary.

**`statusLine` is not a hook** for this purpose — it runs by default. ccairgap can't use Claude Code's `disableAllHooks: true` flag (it would also kill `statusLine`), so the empty-enable default neutralizes hook fields directly, leaving `statusLine` intact.

Not sure what's available? `ccairgap inspect` dumps every hook entry with its raw `command` string — pick globs from real values without hunting through config files.

See `docs/SPEC.md` §"Hook policy" for the full mechanism.

## MCP servers

Your host MCP servers are available inside the sandbox — they just need to be explicitly opted in. By default all MCP servers are disabled because most need per-sandbox setup (binaries in the image, env vars passed through, or host approval for project-scope servers) that doesn't happen automatically at container launch.

Opt servers in with `--mcp-enable <glob>` or `mcp.enable: [glob, ...]` in config. The glob matches each server's `name`:

```bash
# Enable the grafana MCP
ccairgap --mcp-enable 'grafana'

# Enable two servers
ccairgap \
  --mcp-enable 'grafana' \
  --mcp-enable 'playwright'

# Enable anything whose name starts with "codex-"
ccairgap --mcp-enable 'codex-*'
```

**Project-scope servers (`<repo>/.mcp.json`) need host approval too.** Claude Code requires approval before running repo-shipped MCP servers. Inside the sandbox the approval dialog is unreachable, so ccairgap uses host approval as the trust gate: a server matching `--mcp-enable` that hasn't been approved on the host is stripped. Approve on the host first via `/mcp`, then opt in.

If an MCP's binary isn't in your container image, or it relies on env vars not passed through, opting it in still fails at start — extend the Dockerfile and pass env via `--docker-run-arg "-e NAME"`.

Not sure what's available? `ccairgap inspect` shows every server with its source and approval state.

See `docs/SPEC.md` §"MCP policy" for the full mechanism.

## Raw docker run args

Need to publish a port, attach to a custom network, add an env var, or mount something the CLI doesn't surface? Use `--docker-run-arg`:

```bash
# Publish a dev server port
ccairgap --docker-run-arg "-p 8080:8080"

# Attach to a user-created docker network + extra env
ccairgap \
  --docker-run-arg "--network my-net" \
  --docker-run-arg "-e MY_API_KEY=$KEY"

# Mount an additional host dir RW (equivalent to --mount but via raw docker)
ccairgap --docker-run-arg "-v /var/cache/npm:/var/cache/npm:rw"
```

Each value is shell-split with `shell-quote`, so quoting works the way it does in your shell. Tokens are appended after all built-in args so docker's last-wins semantics let you override defaults.

> [!WARNING]
> Raw docker args can weaken or remove the container isolation ccairgap provides (`--privileged`, `--cap-add SYS_ADMIN`, `-v /var/run/docker.sock:/...`, `--network=host`, etc.). The CLI scans for known-sharp tokens and prints a one-line warning per hit — use `--no-warn-docker-args` to silence it. Warnings never block launch; you own the consequences.

If all you need is a single RW path, prefer `--mount <path>` — it's narrower and stays within the structured flag surface.

See `docs/SPEC.md` §"Raw docker run args" for the full spec.

## Config file

Any launch flag can live in a YAML file. Default locations (checked in order): `<git-root>/.ccairgap/config.yaml`, then `<git-root>/.config/ccairgap/config.yaml`. If both exist, `.ccairgap/config.yaml` takes precedence and a warning is printed to stderr. Override with `--config <path>` or `--profile <name>`.

Precedence: **CLI > config > built-in defaults**. Scalars: CLI wins. Arrays (`extra-repo`, `ro`, `docker-run-arg`, etc.): concat (config first, CLI appended). `docker-build-arg` map merges per-key with CLI winning.

### Profiles

`--profile <name>` picks a named config file under the same canonical dir:

- `--profile default` → `config.yaml` (same as no flag).
- `--profile web` → `web.config.yaml` (e.g. `<git-root>/.ccairgap/web.config.yaml`, fallback `<git-root>/.config/ccairgap/web.config.yaml`).

Missing profile file is a hard error. Mutually exclusive with `--config`. No inheritance between profiles — each file stands alone. Relative paths inside a profile file anchor the same way as `config.yaml` (see table below).

### Relative path resolution

| Keys | Anchor | Why |
|------|--------|-----|
| `repo`, `extra-repo`, `ro` | **Workspace anchor** — git root when config is at either canonical location (`<git-root>/.ccairgap/config.yaml` or `<git-root>/.config/ccairgap/config.yaml`); config file's directory otherwise. | `repo: .` means your repo, `ro: ../docs` means a sibling. |
| `dockerfile` | Config file's directory. | Dockerfile is a sidecar that lives next to `config.yaml`. `dockerfile: Dockerfile` = same directory as `config.yaml`. |
| `cp`, `sync`, `mount` | Workspace repo root (resolved at launch against `--repo`). | These name paths inside the workspace (`node_modules`, `dist`, `.cache`). |

Absolute paths bypass anchoring.

Example `<git-root>/.ccairgap/config.yaml` (or `.config/ccairgap/config.yaml`):

```yaml
repo: .                    # optional; defaults to git root
extra-repo:
  - ../sibling
ro:
  - ../docs

dockerfile: Dockerfile     # = .ccairgap/Dockerfile

cp:
  - node_modules
sync:
  - dist
mount:
  - .cache

base: main
docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"
hooks:
  enable:
    - "python3 *"
mcp:
  enable:
    - "grafana"
docker-run-arg:
  - "-p 8080:8080"
```

Both kebab-case (`keep-container`) and camelCase (`keepContainer`) keys are accepted. Unknown keys and wrong types are rejected with a clear error.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List orphaned sessions on disk. |
| `recover [<id>]` | Run handoff (fetch sandbox branch, copy transcripts, rm session dir). Idempotent. With no `<id>`, falls back to `list`. |
| `discard <id>` | Delete a session dir without running handoff. |
| `doctor` | Preflight checks: Docker running, credentials present, image present/stale, state dir writable, `git` + `rsync` + `cp` on PATH. Hash-compares any sidecar `Dockerfile` / `entrypoint.sh` against the bundled copies and warns on drift — useful after a CLI upgrade. |
| `init` | Scaffold `.ccairgap/{Dockerfile, entrypoint.sh, config.yaml}`. Fails if any file exists; `--force` overwrites. |
| `inspect` | Dump every hook, MCP server, env var, and marketplace mount the container would see at launch. JSON to stdout; `--pretty` for tables. Read-only. |

## Environment variables

| Env var | Effect |
|---------|--------|
| `CCAIRGAP_HOME` | Override state dir. Default: `$XDG_STATE_HOME/ccairgap/`. |
| `CCAIRGAP_CC_VERSION` | Short-form for `--docker-build-arg CLAUDE_CODE_VERSION=<value>`. |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # bundles to dist/cli.js via tsup
```

## Contributing

Bug reports and pull requests welcome. Open an issue first for non-trivial changes.

## License

MIT.
