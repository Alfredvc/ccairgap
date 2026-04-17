# ccairgap

[![CI](https://github.com/alfredvc/ccairgap/actions/workflows/ci.yml/badge.svg)](https://github.com/alfredvc/ccairgap/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/ccairgap.svg)](https://www.npmjs.com/package/ccairgap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Run Claude Code with `--dangerously-skip-permissions` inside a Docker container. Hand it a task, walk away. Host filesystem is physically unable to be mutated outside a small set of explicitly writable paths. Exfiltration is an accepted risk; host state destruction is not.

See [`docs/SPEC.md`](docs/SPEC.md) for the full design.

## Install

```bash
npm i -g ccairgap
```

Requires Node ≥ 20 and Docker. Works on macOS; Linux should work; Windows/WSL2 may need path tweaks.

Log in on the host once with `claude` — `ccairgap` inherits those credentials via a read-only mount.

## Quick start

```bash
# Interactive session in the current git repo
ccairgap

# Workspace + sibling repos + a reference dir
ccairgap --repo ~/src/bar --extra-repo ~/src/bar --ro ~/src/docs

# Walk-away via tmux
tmux new -s work 'ccairgap --repo ~/src/bar'

# Non-interactive print mode
ccairgap -p "summarize README"
```

On exit the CLI pushes Claude's work back as a `ccairgap/<ts>` branch in each repo (`--repo` + every `--extra-repo`) via `git fetch` (container never has write access to the real repo). If the session made no commits, no branch is created. If Claude committed to a side branch but left `ccairgap/<ts>` empty, the session dir is preserved with a warning so no work is lost — inspect it, recover what you need, then `ccairgap discard <ts>`.

Git identity (`user.name` / `user.email`) is read from the host at launch (`git config --get`, local-to-`--repo` overrides global) and passed to the container so `git commit` works. If the host has no identity configured, a placeholder (`ccairgap <noreply@ccairgap.local>`) is used and a warning is printed — rewrite authors on the sandbox branch post-hoc if it matters. GPG/SSH signing is not supported inside the container.

## Launch flags

| Flag | Repeatable | Description |
|------|------------|-------------|
| `--config <path>` | no | YAML config file. Default: `<git-root>/.ccairgap/config.yaml`. |
| `--repo <path>` | no | Host repo to expose as the workspace (container cwd). Cloned `--shared`, branch `ccairgap/<ts>` created. Defaults to cwd if it's a git repo. |
| `--extra-repo <path>` | yes | Additional host repo mounted alongside `--repo`. Same clone/branch treatment, but not the workspace. |
| `--ro <path>` | yes | Extra read-only bind mount. |
| `--cp <path>` | yes | Copy a host path into the session at launch. Container sees it RW at the same abs path; changes are discarded on exit (never touch host). Relative paths resolve against the workspace repo. |
| `--sync <path>` | yes | Same copy-in as `--cp`, plus: on exit the container-written copy is rsynced to `$CCAIRGAP_HOME/output/<ts>/<abs-src>/`. Original host path is never written. |
| `--mount <path>` | yes | Plain RW bind-mount host → container at the same abs path. Live host writes, no copy. Opt-in weakening of the host-write invariant for that one path. |
| `--base <ref>` | no | Base ref for `ccairgap/<ts>`. Default: HEAD of each `--repo`. |
| `--keep-container` | no | Omit `docker run --rm` so the container persists for postmortem. |
| `--dockerfile <path>` | no | Build from a user-supplied Dockerfile. |
| `--docker-build-arg KEY=VAL` | yes | Forwarded to `docker build --build-arg`. |
| `--rebuild` | no | Force image rebuild. |
| `-p, --print <prompt>` | no | `claude -p "<prompt>"` instead of the REPL. |
| `-n, --name <name>` | no | Session name. Branch becomes `ccairgap/<name>` instead of `ccairgap/<ts>`; forwarded to `claude -n <name>` so the session shows up with that label in `/resume` and the terminal title. Aborts on invalid git ref or collision with an existing branch in `--repo`. |
| `--hook-enable <glob>` | yes | Opt-in a Claude Code hook whose `command` matches `<glob>`. All hooks are disabled by default inside the sandbox (see below). Wildcard is `*`. |
| `--docker-run-arg <args>` | yes | Extra args appended to `docker run`. Shell-quoted, e.g. `--docker-run-arg "-p 8080:8080"` → two tokens. Appended after built-ins so docker's last-wins lets user args override defaults. Escape hatch — can weaken isolation. |
| `--no-warn-docker-args` | no | Suppress the warning emitted when `--docker-run-arg` contains tokens known to weaken isolation (`--privileged`, `--cap-add`, `--network=host`, `docker.sock`, …). |
| `--bare` | no | Launch a naked container: skip config-file discovery and cwd-as-workspace inference. Mount whatever you need via `--repo` / `--extra-repo` / `--ro` / `--cp` / `--sync` / `--mount`. Relative `--cp`/`--sync`/`--mount` paths anchor on cwd. `--config` still loads when explicit. See `docs/SPEC.md` §"Bare mode". |

## Hooks

All Claude Code hooks are **disabled by default** inside the sandbox. Host hook configs usually reference host-only binaries (`afplay`, project-local `python3` scripts, user-installed CLIs) that are not present in the container; left unfiltered, they would fail every tool call.

Opt hooks back in with `--hook-enable <glob>` or `hooks.enable: [glob, ...]` in config. The glob is matched against the raw `command` string of each hook entry (wildcard `*`, anchored full match). Every hook source is filtered the same way: user `~/.claude/settings.json`, each enabled plugin's `hooks.json`, and project `.claude/settings.json[.local]`.

```bash
# Enable just the python3 auto-deny / auto-approve hooks
ccairgap --hook-enable 'python3 *'

# Enable two specific commands
ccairgap \
  --hook-enable 'python3 *' \
  --hook-enable 'bash ~/.claude/statusline.sh'
```

If a hook's command references a binary that isn't in your container image, opting it in still fails at invocation — extend the Dockerfile (`--dockerfile`) to include the binary.

Unsure what's in scope? `ccairgap inspect` dumps the full config surface the container would see at launch as JSON `{hooks, mcpServers, env, marketplaces}` — every hook entry, every MCP server definition, every `env` var, and every `extraKnownMarketplaces` entry across user settings, enabled plugins, project `.claude/settings.json[.local]`, `~/.claude.json`, and `<repo>/.mcp.json`. Pick globs from real `command` strings, see which MCPs would load, confirm env passthroughs, and know which marketplace source paths will be RO-mounted — without hunting through config files by hand.

See `docs/SPEC.md` §"Hook policy" for the full mechanism.

## Raw docker run args

Need to publish a port, attach to a custom network, add an env var, or mount something the CLI doesn't surface a flag for? Use `--docker-run-arg`:

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

Each value is shell-split with `shell-quote`, so quoting works the way it does in your shell. The tokens are appended after all built-in args, so docker's last-wins semantics let you override defaults (e.g. override `--cap-drop=ALL`, change `--network`, etc.).

**Escape hatch, not a shield.** Raw docker args can weaken or completely remove the container isolation the tool is built to provide (`--privileged`, `--cap-add SYS_ADMIN`, `-v /var/run/docker.sock:/...`, `--network=host`, etc.). The CLI scans for known-sharp tokens and prints a one-line warning per hit on stderr — use `--no-warn-docker-args` (or `warn-docker-args: false` in config) to silence it. Warnings never block launch; you own the consequences.

If the only thing you need is a single RW path, prefer `--mount <path>` — it's narrower in intent and stays within the structured flag surface.

See `docs/SPEC.md` §"Raw docker run args" for the full spec.

## Config file

Any launch flag can live in a YAML file. Default location: `<git-root>/.ccairgap/config.yaml`. Override with `--config <path>`.

Precedence: **CLI > config > built-in defaults**. Scalars (`repo`, `base`, `dockerfile`, `print`, `keep-container`, `rebuild`, `warn-docker-args`): CLI wins. Arrays (`extra-repo`, `ro`, `docker-run-arg`): concat across sources. `docker-build-arg` map merges per-key with CLI winning.

### Relative path resolution

Relative paths inside the config resolve against one of two anchors, depending on the key:

| Keys | Anchor | Why |
|------|--------|-----|
| `repo`, `extra-repo`, `ro` | **Workspace anchor** — the git root when the config lives at `<git-root>/.ccairgap/config.yaml` (the canonical case); the config file's directory otherwise (e.g. when `--config /elsewhere/cfg.yaml` is passed). | These describe your project's repo-space. `repo: .` should mean "my repo", `ro: ../docs` should mean "the dir next to my repo" — not surprises mediated by the `.ccairgap/` subdir. |
| `dockerfile` | **Config file's directory.** | The Dockerfile is a sidecar file that lives next to `config.yaml`. `dockerfile: Dockerfile` means "the Dockerfile in `.ccairgap/`". |
| `cp`, `sync`, `mount` | **Workspace repo root** (resolved at launch, against `--repo`). | These name paths inside the workspace (`node_modules`, `dist`, `.cache`). `--cp node_modules` with `--repo ~/src/bar` → `~/src/foo/node_modules`. |

Absolute paths always work and bypass anchoring.

Example `<git-root>/.ccairgap/config.yaml`:

```yaml
# repo / extra-repo / ro — anchored on the git root (parent of .ccairgap/)
repo: .                    # = the git root
extra-repo:
  - ../sibling             # sibling of the git root
ro:
  - ../docs                # sibling of the git root

# cp / sync / mount — anchored on the workspace repo root at launch
cp:
  - node_modules           # = <git-root>/node_modules
sync:
  - dist                   # = <git-root>/dist
mount:
  - .cache                 # = <git-root>/.cache

# dockerfile — anchored on the config file's directory
dockerfile: Dockerfile     # = <git-root>/.ccairgap/Dockerfile

base: main
rebuild: false
keep-container: false
docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"
# print: "run the test suite"
hooks:
  enable:
    - "python3 *"
    - "bash ~/.claude/statusline.sh"
docker-run-arg:
  - "-p 8080:8080"
  - "--network my-net"
# warn-docker-args: false
```

`repo` is optional — if omitted, it defaults to the git root that contains the config (or the cwd if no config is loaded). Most canonical setups can drop the key entirely.

Both kebab-case (`keep-container`) and camelCase (`keepContainer`) keys are accepted. Unknown keys and wrong types are rejected with a clear error.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List orphaned sessions on disk. |
| `recover [<ts>]` | Run the handoff (fetch sandbox branch, copy transcripts, rm session dir). Idempotent. |
| `discard <ts>` | Delete a session dir without running handoff. |
| `doctor` | Preflight: Docker running, credentials present, image present/stale, state dir writable. Also hash-compares any sidecar `Dockerfile` / `entrypoint.sh` under `<git-root>/.ccairgap/` against the bundled copies and warns on drift. |
| `init` | Materialize the bundled `Dockerfile`, `entrypoint.sh`, and a minimal `config.yaml` (with `dockerfile: Dockerfile`) into `<git-root>/.ccairgap/` — or `dirname(--config)` if `--config` is passed. Fails if any of the three target files exist; `--force` overwrites all three (no merge — prior edits to `config.yaml` are lost). Lets you customize the container image without forking the repo. |
| `inspect` | Enumerate the full config surface the container would see at launch: hook entries, MCP server definitions, `env` vars, and `extraKnownMarketplaces` entries. Walks user `~/.claude/settings.json`, each enabled plugin's `hooks/hooks.json` / `.mcp.json` / `plugin.json#mcpServers`, project `.claude/settings.json[.local]`, `~/.claude.json` (user + user-project `mcpServers`), and `<repo>/.mcp.json` for `--repo` + every `--extra-repo`. Default output: JSON `{hooks, mcpServers, env, marketplaces}` to stdout. `--pretty` renders human-readable tables instead. Managed-settings tiers (OS/MDM/server-delivered) omitted — not mounted into the container. Read-only — useful for picking `--hook-enable` globs, confirming which MCPs will load, and previewing the env + marketplace mounts. |

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

## License

MIT.
