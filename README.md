# ccairgap

[![CI](https://github.com/alfredvc/ccairgap/actions/workflows/ci.yml/badge.svg)](https://github.com/alfredvc/ccairgap/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ccairgap.svg)](https://www.npmjs.com/package/ccairgap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Running Claude with full permissions on your host is risky. Running it with permission prompts means babysitting every tool call — and rules are hard to get right. ccairgap gives you a third option: your Claude Code, running inside Docker with the same skills, config, hooks, and MCP servers, against a sandboxed clone of exactly what it needs. Full permissions. No babysitting. Work lands as a branch when the session ends.

- **Your Claude setup, unchanged.** Config, CLAUDE.md, skills, and slash commands come automatically. Hooks and MCP servers opt in with a single flag.
- **Only what it needs.** Claude gets a clone of your repo(s) — not your host filesystem. Nothing outside that set is reachable or writable.
- **Walk away.** No permission prompts. When the session ends, Claude's commits land as `ccairgap/<ts>` in your repo.
- **Docker underneath.** Custom images, extra mounts, port forwarding — full flexibility when you need it.

> [!NOTE]
> **Threat model.** ccairgap prevents Claude from mutating your host filesystem outside a small explicit set (session scratch, `output/`, transcript copy-back, and the `ccairgap/<ts>` branch via `git fetch`). It does **not** prevent exfiltration — anything the container can read may be sent over the network. See [`SECURITY.md`](SECURITY.md) for the full threat model.

See [`docs/SPEC.md`](docs/SPEC.md) for the full design.

## Contents

- [Setup](#setup)
- [Quick start](#quick-start)
- [Why ccairgap?](#why-ccairgap)
- [Launch flags](#launch-flags)
- [Hooks](#hooks)
- [MCP servers](#mcp-servers)
- [Raw docker run args](#raw-docker-run-args)
- [Config file](#config-file)
- [Subcommands](#subcommands)
- [Environment variables](#environment-variables)
- [Development](#development)
- [Contributing](#contributing)

## Setup

Install:

```bash
npm i -g ccairgap
```

Or run directly with npx:

```bash
npx ccairgap
```

Requires Node ≥ 20, Docker, `git`, and `rsync` on PATH. Tested on macOS; Linux should work; Windows/WSL2 may need path tweaks.

Log in on the host once with `claude` — ccairgap inherits those credentials automatically. First launch builds the container image (one-time; subsequent launches reuse it).

**Git identity.** ccairgap reads your `git config user.name` / `user.email` from the host at launch and passes them to the container so commits work. If no identity is configured, a placeholder `ccairgap <noreply@ccairgap.local>` is used and a warning is printed. GPG/SSH signing is not supported inside the container.

## Quick start

Run with no args inside any git repo:

```bash
ccairgap
```

Claude opens at your repo's root with your full setup — config, CLAUDE.md, skills, slash commands. Hooks and MCP servers are available; see [Hooks](#hooks) and [MCP servers](#mcp-servers) for how to opt them in.

### Common setups

```bash
# Workspace + node_modules (read only)
ccairgap --repo ~/src/foo --ro node_modules

# Two repos: primary workspace + a sibling Claude can read
ccairgap --repo ~/src/foo --extra-repo ~/src/bar

# Hand it a task and walk away
ccairgap -p "add login flow"

# Inside tmux so the session outlives your terminal
tmux new-session -d -s work 'ccairgap -p "add login flow"'
```

### On exit

When the session ends, Claude's commits land as `ccairgap/<ts>` in each repo:

```bash
$ ccairgap -p "add login flow"
# ... Claude works, commits, exits ...
$ git log --oneline ccairgap/20260418T143022Z
a3f1b2c Wire auth middleware
b4e2d8f Add login route
```

- **No commits** → no branch created.
- **Commits on a side branch only** → session dir preserved with a warning. Inspect, recover what you need, then `ccairgap discard <ts>`.

## Why ccairgap?

**vs. running `claude --dangerously-skip-permissions` on your host.** Full permissions on the host means Claude can read and write anything your user account can touch. One bad tool call — or one prompt-injected instruction — can modify or delete files outside your project. ccairgap physically constrains the writable surface: not by rules, but by not mounting those paths at all.

**vs. using Claude with permission prompts.** Prompts work for interactive use but are tedious and easy to misconfigure. Blanket rules risk over-permissioning; precise rules are hard to express. ccairgap skips the permission layer entirely inside the sandbox because the sandbox itself is the permission layer.

**vs. other Claude sandbox tools.** Most give you a stripped-down Claude — no skills, no custom hooks, no project config. ccairgap gives you your Claude: the same `~/.claude/` setup, the same CLAUDE.md, the same plugins. What runs in the container behaves the way you've configured Claude to behave on your host.

## Launch flags

| Flag | Default | Repeatable | Description |
|------|---------|------------|-------------|
| `--config <path>` | `<git-root>/.ccairgap/config.yaml` | no | YAML config file. |
| `--repo <path>` | cwd (if git repo) | no | Host repo exposed as the workspace (container cwd). Cloned `--shared`; branch `ccairgap/<ts>` created on exit. |
| `--extra-repo <path>` | — | yes | Additional repo mounted alongside `--repo`. Same clone/branch treatment, but not the workspace. |
| `--ro <path>` | — | yes | Extra read-only bind mount. |
| `--cp <path>` | — | yes | Copy a host path into the session at launch. Container sees it RW; changes discarded on exit. Relative paths resolve against the workspace repo. |
| `--sync <path>` | — | yes | Same copy-in as `--cp`, plus on exit the container-written copy is rsynced to `$CCAIRGAP_HOME/output/<ts>/<abs-src>/`. Original host path never written. |
| `--mount <path>` | — | yes | Live RW bind-mount. Container writes go directly to the host path. Opt-in weakening of the host-write invariant. |
| `--base <ref>` | HEAD of each repo | no | Base ref for `ccairgap/<ts>`. |
| `--keep-container` | off | no | Omit `docker run --rm` so the container persists for postmortem. |
| `--dockerfile <path>` | bundled | no | Build from a user-supplied Dockerfile. |
| `--docker-build-arg KEY=VAL` | — | yes | Forwarded to `docker build --build-arg`. Use `CLAUDE_CODE_VERSION=<semver>` to pin Claude Code. |
| `--rebuild` | off | no | Force image rebuild. |
| `-p, --print <prompt>` | — | no | `claude -p "<prompt>"` instead of the REPL. |
| `-n, --name <name>` | `<ts>` | no | Session name. Branch becomes `ccairgap/<name>`; forwarded as Claude's session label. Aborts on invalid git ref or branch collision. See notes below. |
| `--hook-enable <glob>` | all disabled | yes | Opt-in a hook by matching its raw `command` string. Wildcard `*`. |
| `--mcp-enable <glob>` | all disabled | yes | Opt-in an MCP server by `name`. Wildcard `*`. |
| `--docker-run-arg <args>` | — | yes | Extra args appended to `docker run`. Shell-quoted. Can weaken isolation. |
| `--no-warn-docker-args` | warnings on | no | Suppress the warning emitted when `--docker-run-arg` contains tokens known to weaken isolation. |
| `--bare` | off | no | Skip config-file discovery and cwd-as-workspace inference. See `docs/SPEC.md` §"Bare mode". |

### Notes on `--name`

The initial `claude -n "<name>"` sets the session label, then on the first user prompt a hook renames the session to `[ccairgap] <name>` (or `[ccairgap]` when unset). That relabeled form is what `/resume` and the TUI's top-border label show. The two-step rename is intentional — matching labels would trigger Claude Code's hook-dedup and skip the TUI rename effect.

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

Any launch flag can live in a YAML file. Default location: `<git-root>/.ccairgap/config.yaml`. Override with `--config <path>`.

Precedence: **CLI > config > built-in defaults**. Scalars: CLI wins. Arrays (`extra-repo`, `ro`, `docker-run-arg`, etc.): concat (config first, CLI appended). `docker-build-arg` map merges per-key with CLI winning.

### Relative path resolution

| Keys | Anchor | Why |
|------|--------|-----|
| `repo`, `extra-repo`, `ro` | **Workspace anchor** — git root when config is at `<git-root>/.ccairgap/config.yaml`; config file's directory otherwise. | `repo: .` means your repo, `ro: ../docs` means a sibling — not mediated by the `.ccairgap/` subdir. |
| `dockerfile` | Config file's directory. | Dockerfile is a sidecar that lives next to `config.yaml`. `dockerfile: Dockerfile` = `.ccairgap/Dockerfile`. |
| `cp`, `sync`, `mount` | Workspace repo root (resolved at launch against `--repo`). | These name paths inside the workspace (`node_modules`, `dist`, `.cache`). |

Absolute paths bypass anchoring.

Example `<git-root>/.ccairgap/config.yaml`:

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
| `recover [<ts>]` | Run handoff (fetch sandbox branch, copy transcripts, rm session dir). Idempotent. With no `<ts>`, falls back to `list`. |
| `discard <ts>` | Delete a session dir without running handoff. |
| `doctor` | Preflight checks: Docker running, credentials present, image present/stale, state dir writable, `git` + `rsync` + `cp` on PATH. Hash-compares any sidecar `Dockerfile` / `entrypoint.sh` against the bundled copies and warns on drift — useful after a CLI upgrade. |
| `init` | Scaffold `.ccairgap/{Dockerfile, entrypoint.sh, config.yaml}`. Fails if any file exists; `--force` overwrites. |
| `inspect` | Dump the full config surface the container would see at launch: every hook entry, MCP server, `env` var, and marketplace mount. JSON `{hooks, mcpServers, env, marketplaces}` to stdout; `--pretty` renders human-readable tables. Accepts `--config`, `--repo`, `--extra-repo`. Read-only — useful for picking `--hook-enable` / `--mcp-enable` globs before launch. |

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
