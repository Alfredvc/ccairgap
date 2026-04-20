# Launch flags

| Flag | Default | Repeatable | Description |
|------|---------|------------|-------------|
| `--config <path>` | `<git-root>/.ccairgap/config.yaml` (fallback: `<git-root>/.config/ccairgap/config.yaml`) | no | YAML config file. See [config.md](config.md). |
| `--profile <name>` | — | no | Named config under the canonical dir: `default` = `config.yaml`, any other `<name>` = `<name>.config.yaml`. Missing profile file is a hard error. Mutually exclusive with `--config`. |
| `--repo <path>` | cwd (if git repo) | no | Host repo exposed as the workspace (container cwd). Cloned `--shared`; branch `ccairgap/<id>` created on exit. |
| `--extra-repo <path>` | — | yes | Additional repo mounted alongside `--repo`. Same clone/branch treatment, but not the workspace. |
| `--ro <path>` | — | yes | Extra read-only bind mount. |
| `--cp <path>` | — | yes | Copy a host path into the session at launch. Container sees it RW; changes discarded on exit. Relative paths resolve against the workspace repo. |
| `--sync <path>` | — | yes | Same copy-in as `--cp`, plus on exit the container-written copy is rsynced to `$CCAIRGAP_HOME/output/<id>/<abs-src>/`. Original host path never written. |
| `--mount <path>` | — | yes | Live RW bind-mount. Container writes go directly to the host path. Opt-in weakening of the host-write invariant. |
| `--base <ref>` | HEAD of each repo | no | Base ref for `ccairgap/<id>`. |
| `--keep-container` | off | no | Omit `docker run --rm` so the container persists for postmortem. |
| `--dockerfile <path>` | bundled | no | Build from a user-supplied Dockerfile. See [dockerfile.md](dockerfile.md). |
| `--docker-build-arg KEY=VAL` | — | yes | Forwarded to `docker build --build-arg`. Use `CLAUDE_CODE_VERSION=<semver>` to pin Claude Code. |
| `--rebuild` | off | no | Force image rebuild. |
| `-p, --print <prompt>` | — | no | `claude -p "<prompt>"` instead of the REPL. |
| `-n, --name <name>` | random `<adj>-<noun>` | no | Session id **prefix**. The CLI always appends a 4-hex suffix; the final id is `<name>-<4hex>`. Drives the session dir, docker container (`ccairgap-<id>`), branch (`ccairgap/<id>`), and Claude's session label. Must be a valid git ref component. See notes below. |
| `-r, --resume <id-or-name>` | — | no | Resume an existing Claude session inside the sandbox. Accepts a session **UUID** or the session's **custom title** (case-insensitive exact match). Ambiguous or missing titles error with a candidate list. Works with both host-born and ccairgap-born sessions. Requires a workspace repo. On exit, ccairgap prints `ccairgap --resume <uuid>` so you can re-enter. |
| `--hook-enable <glob>` | all disabled | yes | Opt-in a hook by matching its raw `command` string. Wildcard `*`. See [hooks.md](hooks.md). |
| `--mcp-enable <glob>` | all disabled | yes | Opt-in an MCP server by `name`. Wildcard `*`. See [mcp.md](mcp.md). |
| `--docker-run-arg <args>` | — | yes | Extra args appended to `docker run`. Shell-quoted. Can weaken isolation. See [docker-run-args.md](docker-run-args.md). |
| `--no-warn-docker-args` | warnings on | no | Suppress the warning emitted when `--docker-run-arg` contains tokens known to weaken isolation. |
| `--no-preserve-dirty` | off | no | Skip the dirty-working-tree preservation check on exit. Intended for scripted / CI use where uncommitted container-side edits are disposable. Orphan-branch and scan-failure preservation still fire. |
| `--refresh-below-ttl <mins>` | 120 | no | Host token ttl threshold (minutes) for pre-launch auth refresh. `0` disables the refresh; cold-start-dead refusal still fires. See [auth-refresh.md](auth-refresh.md). |
| `--no-auto-memory` | — | no | Skip the auto-memory RO mount. See [auto-memory.md](auto-memory.md). |
| `--no-clipboard` | — | no | Disable image-clipboard passthrough. See [clipboard.md](clipboard.md). |
| `--bare` | off | no | Skip config-file discovery and cwd-as-workspace inference. See [SPEC.md](SPEC.md) §"Bare mode". |
| `-- <claude-args…>` | — | no | Tokens after `--` are forwarded verbatim to `claude` inside the container. See [claude-args.md](claude-args.md). |

## Notes on `--name`

- Session label is always `ccairgap <id>`; TUI title is `[ccairgap] <id>`. Without `--name`, `<id>` is `<adj>-<noun>-<4hex>` (random). With `--name foo`, `<id>` is `foo-<4hex>`.
- `--name` supplies only the **prefix**; a 4-hex suffix is always appended (`<name>-<4hex>`), so two launches with the same `--name` never collide on branch, container, or session dir.
- The full `<id>` surfaces in `ccairgap list`, the container name (`ccairgap-<id>`), the branch (`ccairgap/<id>`), and the session directory.
- The two-step rename (label → title) is intentional: the two strings still differ, so Claude Code's hook-dedup fires and the TUI rename effect paints the top-border.
- `--resume <id-or-name>`: the resumed session uses the new `<id>` as its label — prior display name is not preserved.
