# claude-airgap

[![CI](https://github.com/alfredvc/claude-airgap/actions/workflows/ci.yml/badge.svg)](https://github.com/alfredvc/claude-airgap/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/claude-airgap.svg)](https://www.npmjs.com/package/claude-airgap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Run Claude Code with `--dangerously-skip-permissions` inside a Docker container. Hand it a task, walk away. Host filesystem is physically unable to be mutated outside a small set of explicitly writable paths. Exfiltration is an accepted risk; host state destruction is not.

See [`docs/SPEC.md`](docs/SPEC.md) for the full design.

## Install

```bash
npm i -g claude-airgap
```

Requires Node ≥ 20 and Docker. Works on macOS; Linux should work; Windows/WSL2 may need path tweaks.

Log in on the host once with `claude` — `ccairgap` inherits those credentials via a read-only mount.

## Quick start

```bash
# Interactive session in the current git repo
ccairgap

# Workspace + sibling repos + a reference dir
ccairgap --repo ~/src/foo --extra-repo ~/src/bar --ro ~/src/docs

# Walk-away via tmux
tmux new -s work 'ccairgap --repo ~/src/foo'

# Non-interactive print mode
ccairgap -p "summarize README"
```

On exit the CLI pushes Claude's work back as a `sandbox/<ts>` branch in each repo (`--repo` + every `--extra-repo`) via `git fetch` (container never has write access to the real repo). If the session made no commits, no branch is created. If Claude committed to a side branch but left `sandbox/<ts>` empty, the session dir is preserved with a warning so no work is lost — inspect it, recover what you need, then `ccairgap discard <ts>`.

Git identity (`user.name` / `user.email`) is read from the host at launch (`git config --get`, local-to-`--repo` overrides global) and passed to the container so `git commit` works. If the host has no identity configured, a placeholder (`claude-airgap <noreply@airgap.local>`) is used and a warning is printed — rewrite authors on the sandbox branch post-hoc if it matters. GPG/SSH signing is not supported inside the container.

## Launch flags

| Flag | Repeatable | Description |
|------|------------|-------------|
| `--config <path>` | no | YAML config file. Default: `<git-root>/.claude-airgap/config.yaml`. |
| `--repo <path>` | no | Host repo to expose as the workspace (container cwd). Cloned `--shared`, branch `sandbox/<ts>` created. Defaults to cwd if it's a git repo. |
| `--extra-repo <path>` | yes | Additional host repo mounted alongside `--repo`. Same clone/branch treatment, but not the workspace. |
| `--ro <path>` | yes | Extra read-only bind mount. |
| `--cp <path>` | yes | Copy a host path into the session at launch. Container sees it RW at the same abs path; changes are discarded on exit (never touch host). Relative paths resolve against the workspace repo. |
| `--sync <path>` | yes | Same copy-in as `--cp`, plus: on exit the container-written copy is rsynced to `$CLAUDE_AIRGAP_HOME/output/<ts>/<abs-src>/`. Original host path is never written. |
| `--mount <path>` | yes | Plain RW bind-mount host → container at the same abs path. Live host writes, no copy. Opt-in weakening of the host-write invariant for that one path. |
| `--base <ref>` | no | Base ref for `sandbox/<ts>`. Default: HEAD of each `--repo`. |
| `--keep-container` | no | Omit `docker run --rm` so the container persists for postmortem. |
| `--dockerfile <path>` | no | Build from a user-supplied Dockerfile. |
| `--docker-build-arg KEY=VAL` | yes | Forwarded to `docker build --build-arg`. |
| `--rebuild` | no | Force image rebuild. |
| `-p, --print <prompt>` | no | `claude -p "<prompt>"` instead of the REPL. |
| `-n, --name <name>` | no | Session name. Branch becomes `sandbox/<name>` instead of `sandbox/<ts>`; forwarded to `claude -n <name>` so the session shows up with that label in `/resume` and the terminal title. Aborts on invalid git ref or collision with an existing branch in `--repo`. |
| `--hook-enable <glob>` | yes | Opt-in a Claude Code hook whose `command` matches `<glob>`. All hooks are disabled by default inside the sandbox (see below). Wildcard is `*`. |

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

See `docs/SPEC.md` §"Hook policy" for the full mechanism.

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
cp:
  - node_modules
sync:
  - dist
mount:
  - .cache
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
```

Build-artifact keys (`cp`, `sync`, `mount`) take relative paths resolved against the workspace repo root at launch (not the config file's directory — unlike `repo` / `ro`). Use absolute paths to break out of the workspace.

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
| `CLAUDE_AIRGAP_HOME` | Override state dir. Default: `$XDG_STATE_HOME/claude-airgap/`. |
| `CLAUDE_AIRGAP_CC_VERSION` | Short-form for `--docker-build-arg CLAUDE_CODE_VERSION=<value>`. |

## Development

```bash
npm install
npm run typecheck
npm test
npm run build   # bundles to dist/cli.js via tsup
```

## License

MIT.
