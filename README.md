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

# Workspace + sibling repos + a reference dir
claude-airlock --repo ~/src/foo --extra-repo ~/src/bar --ro ~/src/docs

# Walk-away via tmux
tmux new -s work 'claude-airlock --repo ~/src/foo'

# Non-interactive print mode
claude-airlock -p "summarize README"
```

On exit the CLI pushes Claude's work back as a `sandbox/<ts>` branch in each repo (`--repo` + every `--extra-repo`) via `git fetch` (container never has write access to the real repo). If the session made no commits, no branch is created. If Claude committed to a side branch but left `sandbox/<ts>` empty, the session dir is preserved with a warning so no work is lost — inspect it, recover what you need, then `claude-airlock discard <ts>`.

Git identity (`user.name` / `user.email`) is read from the host at launch (`git config --get`, local-to-`--repo` overrides global) and passed to the container so `git commit` works. If the host has no identity configured, a placeholder (`claude-airlock <noreply@airlock.local>`) is used and a warning is printed — rewrite authors on the sandbox branch post-hoc if it matters. GPG/SSH signing is not supported inside the container.

## Launch flags

| Flag | Repeatable | Description |
|------|------------|-------------|
| `--config <path>` | no | YAML config file. Default: `<git-root>/.claude-airgap/config.yaml`. |
| `--repo <path>` | no | Host repo to expose as the workspace (container cwd). Cloned `--shared`, branch `sandbox/<ts>` created. Defaults to cwd if it's a git repo. |
| `--extra-repo <path>` | yes | Additional host repo mounted alongside `--repo`. Same clone/branch treatment, but not the workspace. |
| `--ro <path>` | yes | Extra read-only bind mount. |
| `--base <ref>` | no | Base ref for `sandbox/<ts>`. Default: HEAD of each `--repo`. |
| `--keep-container` | no | Omit `docker run --rm` so the container persists for postmortem. |
| `--dockerfile <path>` | no | Build from a user-supplied Dockerfile. |
| `--docker-build-arg KEY=VAL` | yes | Forwarded to `docker build --build-arg`. |
| `--rebuild` | no | Force image rebuild. |
| `-p, --print <prompt>` | no | `claude -p "<prompt>"` instead of the REPL. |

## Config file

Any launch flag can live in a YAML file. Default location: `<git-root>/.claude-airgap/config.yaml`. Override with `--config <path>`.

Precedence: **CLI > config > built-in defaults**. Scalars (`repo`, `base`, `dockerfile`, `print`, `keep-container`, `rebuild`): CLI wins. Arrays (`extra-repo`, `ro`): concat across sources. `docker-build-arg` map merges per-key with CLI winning. Relative paths inside the config resolve against the config file's directory.

Example `.claude-airgap/config.yaml`:

```yaml
repo: .
extra-repo:
  - ../sibling
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
