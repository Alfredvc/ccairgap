# claude-airlock

Run Claude Code with `--dangerously-skip-permissions` inside a Docker container. Hand it a task, walk away. Host filesystem is physically unable to be mutated outside a small set of explicitly writable paths. Exfiltration is an accepted risk; host state destruction is not.

See [`docs/SPEC.md`](docs/SPEC.md) for the full design.

## Install

```bash
npm i -g claude-airlock
```

Requires Node ≥ 20 and Docker. Works on macOS; Linux should work; Windows/WSL2 may need path tweaks.

Log in on the host once with `claude` — `claude-airlock` inherits those credentials via a read-only mount.

## Quick start

```bash
# Interactive session in the current git repo
claude-airlock

# Multiple repos + a reference dir
claude-airlock --repo ~/src/foo --repo ~/src/bar --ro ~/src/docs

# Walk-away via tmux
tmux new -s work 'claude-airlock --repo ~/src/foo'

# Non-interactive print mode
claude-airlock -p "summarize README"
```

On exit the CLI pushes Claude's work back as a `sandbox/<ts>` branch in each `--repo` via `git fetch` (container never has write access to the real repo).

## Launch flags

| Flag | Repeatable | Description |
|------|------------|-------------|
| `--config <path>` | no | YAML config file. Default: `<git-root>/.claude-airgap/config.yaml`. |
| `--repo <path>` | yes | Host repo to expose. Cloned `--shared`, branch `sandbox/<ts>` created. Defaults to cwd if it's a git repo. |
| `--ro <path>` | yes | Extra read-only bind mount. |
| `--base <ref>` | no | Base ref for `sandbox/<ts>`. Default: HEAD of each `--repo`. |
| `--keep-container` | no | Omit `docker run --rm` so the container persists for postmortem. |
| `--dockerfile <path>` | no | Build from a user-supplied Dockerfile. |
| `--docker-build-arg KEY=VAL` | yes | Forwarded to `docker build --build-arg`. |
| `--rebuild` | no | Force image rebuild. |
| `-p, --print <prompt>` | no | `claude -p "<prompt>"` instead of the REPL. |

## Config file

Any launch flag can live in a YAML file. Default location: `<git-root>/.claude-airgap/config.yaml`. Override with `--config <path>`.

Precedence: **CLI > config > built-in defaults**. Arrays (`repo`, `ro`) concat across sources. `docker-build-arg` map merges per-key with CLI winning. Relative paths inside the config resolve against the config file's directory.

Example `.claude-airgap/config.yaml`:

```yaml
repo:
  - .
ro:
  - ../docs
base: main
rebuild: false
keep-container: false
docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"
# print: "run the test suite"
```

Both kebab-case (`keep-container`) and camelCase (`keepContainer`) keys are accepted. Unknown keys and wrong types are rejected with a clear error.

## Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List orphaned sessions on disk. |
| `recover [<ts>]` | Run the handoff (fetch sandbox branch, copy transcripts, rm session dir). Idempotent. |
| `discard <ts>` | Delete a session dir without running handoff. |
| `doctor` | Preflight: Docker running, credentials present, image present/stale, state dir writable. |

## Environment variables

| Env var | Effect |
|---------|--------|
| `CLAUDE_AIRLOCK_HOME` | Override state dir. Default: `$XDG_STATE_HOME/claude-airlock/`. |
| `CLAUDE_AIRLOCK_CC_VERSION` | Short-form for `--docker-build-arg CLAUDE_CODE_VERSION=<value>`. |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # bundles to dist/cli.js via tsup
```

## License

MIT.
