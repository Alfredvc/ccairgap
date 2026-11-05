# ccairgap — Spec

Run `claude --dangerously-skip-permissions` in a Docker container so you can hand it a task and walk away. Without a network policy, exfiltration is an accepted risk. Host state destruction is never accepted.

## Goal

- Full-permission Claude Code inside a container.
- Host filesystem physically unable to be destroyed or mutated outside a small set of explicitly writable paths.
- Container work product (branches, transcripts) reachable on the host after session ends, without requiring the container to have write access to host state during the session.
- Behavior parity with host Claude: same plugins, skills, slash commands, global CLAUDE.md, settings, MCP configuration.

## Threat model

- **Accepted without a network policy:** full exfiltration. Anything the container can read may be sent over the network.
- **Reduced with a network policy:** the `network` config key limits outbound traffic to the hosts, ports, methods and paths that the policy allows. See §"Network policy" for what the policy enforces and what stays open.
- **Not accepted:** any write to host filesystem outside the small set of explicitly writable paths listed in §"Host writable paths". Specifically: real git repositories, host `~/.claude/`, host `~/.claude.json`, and anything else on disk must survive the session byte-for-byte.
- **Container escape:** not part of the threat model. The CLI's built-in docker invocation does not lower default Docker isolation (no `--privileged`, no `SYS_ADMIN`, no `docker.sock` mount). Users can opt into any docker flag via `--docker-run-arg` (see §"Raw docker run args"); that surface is user-foot-gun territory, not a defense claim.

## Implementation

- **Language:** TypeScript, compiled to a single bundled JS file with [tsup](https://tsup.egoist.dev/).
- **Runtime:** Node.js ≥ 20 on the host. The container uses its own Node 24 base image independently.
- **Distribution:** npm package `ccairgap`. Primary install path is `npm i -g ccairgap`; `npx ccairgap …` works for one-shot use.
- **Package layout:**
  - `dist/cli.js` — bundled entry, declared in `package.json` `bin`.
  - `docker/Dockerfile` — shipped as a package asset; read by the CLI at build time and used to compute the published base image tag for `ccairgap init`.
  - `docker/entrypoint.sh` — runs inside the container; stays in bash (fixed Alpine-ish environment, no portability concerns).
- **Dependencies kept lean:** `commander` for arg parsing, `execa` for shelling out to `docker` / `git`. No runtime dep on external config libraries.
- **License:** MIT.
- **Repository:** `github.com/alfredvc/ccairgap`.

## Versioning

- **CLI:** semver. Patch = bug fixes, minor = new flags / new optional manifest fields, major = flag rename or removal, manifest shape change, or state-dir layout change.
- **Container image tag** = CLI version + content hash of `Dockerfile`+`entrypoint.sh`+exact resolved Claude Code and Codex versions (or `custom-<hash>` over the user Dockerfile plus exact resolved agent versions and the managed base image identity when used). Generated sidecars inherit a runtime base image that does not include agent-version installs. See §"Container image".
- **Agent versions inside the image:** default `latest` inputs resolve to exact host `claude --version` and `codex --version` values before image work begins. `latest` is not a build identity and is never passed to the bundled Dockerfile. Users can override with exact `--docker-build-arg CLAUDE_CODE_VERSION=<semver>` and `--docker-build-arg CODEX_VERSION=<semver>`, but normal host-agent upgrades need no build args. When an agent binary is missing on the host (or its version is not exact), that agent resolves to its release pin in the bundled `docker/agent-versions.env`. The image always installs both agents, so a host with only Claude Code or only Codex can launch either way; only the missing agent gets the release version. Launch fails only when the host, the pin, and build args all lack an exact version.
- **Manifest schema:** `$SESSION/manifest.json` carries a top-level `"version": <N>` field. The handoff routine reads it first and errors clearly on unknown versions. Bump only when the shape changes incompatibly.
- **Flag stability:** launch-command flags and subcommand names are part of the public API. Renaming or removing either requires a major version bump.

## Host storage layout

All paths follow XDG Base Directory convention.

```
${XDG_STATE_HOME:-$HOME/.local/state}/ccairgap/
├── sessions/
│   └── <id>/                      # per-session state, ephemeral
│       ├── repos/
│       │   └── <repo-name>/       # git clone --shared of host repo
│       ├── transcripts/           # bind-mounted at container ~/.claude/projects/
│       └── (other per-session scratch)
└── output/                        # single reused dir, bind-mounted at /output
```

- `<id>` is the session identifier. Generated as `<prefix>-<4hex>` where:
  - **prefix** is `--name <name>` if the user passed one, otherwise a random
    `<adj>-<noun>` pair drawn from the bundled word list in `src/sessionId.ts`.
  - **4hex** is always appended (via `crypto.randomBytes`) so collisions are
    rare even for fixed prefixes (65536 combos per prefix).
- The id drives four things uniformly: session dir (`$XDG_STATE_HOME/ccairgap/sessions/<id>`),
  docker container (`ccairgap-<id>`), sandbox branch (`ccairgap/<id>`), and
  Claude's session label (`-n "ccairgap <id>"`, rewritten to `[ccairgap] <id>`
  by the rename hook on first prompt).
- On collision with any of session dir / running-or-stopped container / workspace
  branch, the hex suffix is re-rolled up to 8 times before aborting.
- Validated once via `git check-ref-format refs/heads/ccairgap/<id>`; a bad
  `--name` surfaces before any filesystem side effects.
- Host `~/.claude/` is the source of credentials, settings, plugins, skills, commands, CLAUDE.md. It is RO-mounted into the container; there is no separate profile volume.

When `CLAUDE_CONFIG_DIR` is set on the host, ccairgap reads that directory instead of `~/.claude/` for both the config directory and `.claude.json` (resolved as `<CLAUDE_CONFIG_DIR>/.claude.json`). This matches Claude Code's own resolution. The variable is **not** forwarded into the container; inside the sandbox the config home is always the default `~/.claude`.

## Host writable paths (the only ones)

A session may cause writes to:

1. `$XDG_STATE_HOME/ccairgap/sessions/<id>/` — session scratch, created fresh, deleted on exit after transcripts copy. Includes `$SESSION/creds/.credentials.json` (always materialized; **rewritten atomically by the runtime auth-refresh watcher; see §"Authentication flow"**), `$SESSION/auth-warnings/current.txt` (runtime-watcher banner — atomic tmp+rename), `$SESSION/auth-refresh-state.json` (per-tick status for `ccairgap doctor`), `$SESSION/hook-policy/` (patched user settings + per-repo hook overlays; see §"Hook policy"), `$SESSION/plugin-policy/` (filtered plugin hook / MCP files; see §"Plugin policy"), `$SESSION/host-claude-placeholder/` (empty `~/.claude/` and `{}` `~/.claude.json` mount sources, written only when the host has no Claude config, e.g. a host with only Codex), `$SESSION/claude-symlink-overlay/` (host-side materialization of symlinks under `~/.claude/` whose targets are outside `~/.claude/`; see §"Container mount manifest"), session-local Codex state under `$SESSION/codex-home/`, `$SESSION/codex-auth/`, and `$SESSION/codex-sessions/`, and `$SESSION/network/` (network policy files; see §"Network policy").
2. `$XDG_STATE_HOME/ccairgap/output/` — `/output` mount inside container, plus `output/<id>/<abs-src>/` subtrees written by the exit-trap for every `--sync` path.
3. `~/.claude/projects/<path-encoded-cwd>/` — transcript copy-back on exit.
4. Real host repos passed to `--repo` and `--extra-repo`: **only** the refs `ccairgap/<id>` and `ccairgap/<id>-worktrees/<branch>` are created via `git fetch` on exit. No other mutations. `.git/objects` is RO-mounted into the container.
5. User-declared `--mount <path>` targets — live RW bind-mount from container to host. Opt-in per path. This class of write can mutate arbitrary host state during a running session and exists to support artifact caches (e.g. `node_modules`) the user explicitly trusts the container with.
6. Anything a user adds via `--docker-run-arg` (see §"Raw docker run args"). Raw docker args are pass-through: a `-v <host>:<ctr>:rw`, `--mount`, `--pid=host`, etc. supplied this way can make host writes or weaken isolation beyond `--mount`'s narrow per-path semantics. Treated as user-declared opt-out.
7. `$SESSION/clipboard-bridge/current.png` — image bytes written by the host-side clipboard watcher. Created on launch when clipboard passthrough is active; removed on handoff.

No other host path is writable by the container. `~/.claude/`, `~/.claude.json`, plugin marketplace repos, `--ro` reference paths are all RO-mounted.

The host auto-memory directory is mounted **read-only**. Writes from inside the container (extract-memories background worker, `/remember`, team sync) fail with EROFS and are swallowed by Claude Code's callers. The auto-memory path is not in the host-writable set.

This list covers paths ccairgap itself writes. When pre-launch auth refresh runs (see §"Authentication flow"), ccairgap shells out to the supported public `claude auth login` subcommand on the host; that process writes through its own storage paths (keychain on macOS, `~/.claude/.credentials.json` on Linux) — ccairgap does not write those paths directly.

## Command line interface

```
ccairgap [SUBCOMMAND] [OPTIONS]
ccairgap exec [OPTIONS] -- <command...>
```

Default (no subcommand): start a new session.

**Launch flags** (apply to the default `ccairgap` invocation):

| Flag | Repeatable | Description |
|------|------------|-------------|
| `--agent <claude\|codex>` | no | Select the agent provider. Default is `claude`. `codex` runs Codex CLI inside the ccairgap container with selected-agent validation, sanitized session-local Codex state, selected-only auth behavior, and image contract inspection. For `exec`, this selects the prepared environment, not the final command binary. |
| `--repo <host-path>` | no | Host repo exposed as the workspace (container cwd). Cloned with `--shared`, new branch `ccairgap/<id>` created. If omitted, defaults to the current working directory (must be a git repo). |
| `--extra-repo <host-path>` | yes | Additional host repo mounted alongside `--repo`. Same `--shared` clone + `ccairgap/<id>` branch, but not the workspace. Use for sibling repos Claude reads but does not work in as its primary target. |
| `--ro <host-path>` | yes | Additional read-only bind mount. Path can be anything — a git repo, a docs dir, any reference material. `--ro` never creates a sandbox branch; Claude gets read-only visibility. |
| `--cp <path>` | yes | Copy host path into the session at launch; container sees it RW at the same absolute path. Changes are discarded on exit (never reach host). Relative paths resolve against the workspace repo root. See §"Build artifact paths". |
| `--sync <path>` | yes | Same pre-launch copy as `--cp`, plus: on exit the container-written copy is rsynced to `$CCAIRGAP_HOME/output/<id>/<abs-source-path>/`. The original host path is never written to. See §"Build artifact paths". |
| `--mount <path>` | yes | RW bind-mount host path directly into the container at the same absolute path. Live host writes; no copy. Relative paths resolve against the workspace repo root. Breaks the "container never writes host repo directly" invariant for the declared path only — opt-in. See §"Build artifact paths". |
| `--base <ref>` | no | Base ref for `ccairgap/<id>` branch. Default: current HEAD of each repo (`--repo` + every `--extra-repo`). |
| `--keep-container` | no | Omit `docker run --rm`. Container persists after exit for postmortem via `docker logs` / `docker exec`. Manual cleanup: `docker rm ccairgap-<id>`. |
| `--dockerfile <path>` | no | Build from a user-supplied Dockerfile instead of the bundled one. Resulting image tag carries a `custom-<hash>` suffix (see §"Container image"). |
| `--docker-build-arg KEY=VAL` | yes | Forwarded to `docker build --build-arg`. Omit agent-version args to follow exact host Claude Code and Codex versions automatically; set exact `CLAUDE_CODE_VERSION=1.2.3` or `CODEX_VERSION=1.2.3` only to intentionally pin away from the host. Non-exact values fail before image pull/build. |
| `--rebuild` | no | Force rebuild of the container image before launching, even if the tag already exists locally. |
| `-p, --print <prompt>` | no | Run the selected agent in non-interactive print mode: Claude uses `claude -p "<prompt>"`; Codex uses `codex exec`. For selected Codex, host `CODEX_API_KEY` is forwarded only in print mode and can satisfy selected auth for that launch. Not supported for `exec`, including config-sourced `print`. |
| `-r, --resume <id-or-name>` | no | Resume an existing Claude session inside the sandbox. Accepts **either** a session UUID **or** the session's custom title (what `claude` prints on exit). Titles are matched case-insensitively and must be exact; 0 or >1 matches abort launch with a candidate list. The CLI copies `~/.claude/projects/<encoded-workspace-cwd>/<uuid>.jsonl` (plus the optional `<uuid>/` subagents dir) into `$SESSION/transcripts/` before `docker run`. Inside the container, `claude -r "$CCAIRGAP_RESUME"` always uses the resolved UUID (not the raw name). Requires a workspace repo; errors under `--bare` / ro-only. Works with both host-born and ccairgap-born sessions — no separate UX per origin. Config key: `resume: <id-or-name>` (scalar). Not supported for `exec`, including config-sourced `resume`. |
| `-n, --name <name>` | no | Session id **prefix**. The CLI always appends a 4-hex suffix, so the final `<id>` is `<name>-<4hex>`. Drives the sandbox branch (`ccairgap/<id>`), docker container (`ccairgap-<id>`), session dir, and Claude's session label (`-n "<name>"`, rewritten to `[ccairgap] <name>` by the UserPromptSubmit hook on first prompt; see §"Container entrypoint" for the full precedence). Validated once via `git check-ref-format refs/heads/ccairgap/<id>`; the CLI aborts before any side effects if `<name>` would produce an invalid ref. On collision with an existing session dir, container (running or stopped), or branch in the workspace repo (`--repo`), the hex suffix is re-rolled up to 8 times before aborting. `--extra-repo` branches are not pre-checked, so a stale branch in one of them surfaces at fetch time on exit. Omitted, a random `<adj>-<noun>` prefix is generated — see §"Session identifier". |
| `--hook-enable <glob>` | yes | Opt-in a Claude Code hook whose raw `command` string matches `<glob>`. All hooks are **disabled by default** inside the sandbox — the host's hook commands typically reference host binaries (`afplay`, project-local `python3` scripts, etc.) that don't exist in the container and would fail every tool call. Each `--hook-enable` adds one glob; the full set is matched against hooks from every source (user settings, enabled plugins, project settings). See §"Hook policy". Repeatable. |
| `--docker-run-arg <args>` | yes | Extra args appended to the `docker run` command. Value is shell-split via `shell-quote`, so `--docker-run-arg "-p 8080:8080"` expands to two tokens. Appended after all built-in args so docker's last-wins semantics let user args override defaults (`--cap-drop` and others, and `--network` without a network policy). Repeatable. See §"Raw docker run args". |
| `--no-warn-docker-args` | no | Suppress the "dangerous token" warning emitted when `--docker-run-arg` contains flags known to weaken isolation (`--privileged`, `--cap-add`, `--network=host`, `docker.sock`, …). Warning-only without a network policy. With a policy, the CLI rejects conflicting tokens, and this flag does not change that. See §"Network policy". |
| `--no-auto-memory` | no | Kill switch for the auto-memory RO mount + `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var. When set, ccairgap does not surface the host auto-memory directory into the container; Claude Code falls back to its in-container default path under `~/.claude/projects/<sanitized>/memory/` which only exists for the current session (discarded on exit). Config key: `no-auto-memory: true`. |
| `--bare` | no | Launch a "naked" container: no config-file loading, no workspace-repo inference from cwd. User mounts whatever they need via `--repo` / `--extra-repo` / `--ro` / `--cp` / `--sync` / `--mount`. All Claude config flow is unchanged (`~/.claude` RO mount, credentials, plugins cache, etc.). See §"Bare mode". |
| `-- <selected-agent-args…>` | no | Tokens after `--` are the selected-agent passthrough tail for the default launch command. With `--agent claude`, they are forwarded verbatim to the in-container `claude` invocation, subject to the Claude denylist (see §"Selected-agent arg passthrough"). With `--agent codex`, they are forwarded to Codex after fail-closed allowlist validation and container-visible `--image` checks. For `ccairgap exec -- <command...>`, the tail is instead the exact command argv. |

No `--auth` flag. Credentials are inherited from the host's `~/.claude/` via RO mount. If you are not logged in on the host, run `claude` on the host first.

### Codex launch semantics

Claude remains the default selected agent. When `--agent codex` or `agent: codex` is selected, launch validation changes before any session directory is created:

- A workspace repo is required. `--agent codex --bare --repo <path>` is valid, but ro-only/no-repo launches and `--agent codex --bare` without `--repo` fail before side effects.
- `--resume` is rejected before side effects. Resume remains Claude-only until Codex resume semantics are designed.
- Codex passthrough args are validated with the Codex allowlist, and `--image` values must already be visible through a workspace repo, `--ro`, `--cp`, `--sync`, or `--mount`.
- Non-exact `CODEX_VERSION` build args fail before image pull/build. After image resolution, ccairgap inspects the image for both agent binaries, the launch-resolved Claude Code and Codex versions, and required Codex mount targets.
- Selected Codex auth is fatal unless `--print` has a host `CODEX_API_KEY`. In that print-mode API-key case, `$CODEX_HOME/auth.json` is advisory and copied only if it sanitizes safely.
- Claude credentials may be copied as advisory peer state for a Codex-selected launch, but selected Codex never runs the Claude pre-launch refresh path and never starts the runtime auth-refresh watcher.

At Docker execution, ccairgap passes `CCAIRGAP_AGENT=codex`, `CODEX_HOME=/home/claude/.codex`, and the validated Codex argv tail. The entrypoint runs `codex` for interactive mode and `codex exec` for print mode.

For `ccairgap exec --agent codex -- <command...>`, Codex still controls the prepared environment and selected auth/config policy, but the final argv is the user command after `--`, not `codex`.

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `list` | List orphaned sessions (session dirs on disk with no running container). Prints timestamp, repos involved, and commit counts on `ccairgap/<id>`. |
| `recover [<id>]` | Run the handoff routine against `$SESSION/<id>/`. Idempotent. With no `<id>` argument, equivalent to `list`. |
| `discard <id>` | Delete `$SESSION/<id>/` without running handoff. Use when you don't want the sandbox branch in your real repo. |
| `attach <id>` | Spawn a second selected agent inside the running container `ccairgap-<id>` via `docker exec`. Advanced. Defaults to the session manifest agent, with absent `agent` in old manifests treated as `claude`; `--agent claude\|codex` can override when that agent's in-container state exists. `attach` is the only subcommand that accepts a selected-agent `--` passthrough tail. See §"Attach". |
| `exec -- <command...>` | Prepare the selected-agent environment and run an arbitrary command as exact argv. `--` is required before the command; no shell parsing is performed. `--agent` selects the prepared environment, not the final binary. `--print` and `--resume` are rejected, including config-sourced values. Config `claude-args` / `codex-args` are ignored with a warning in exec mode. Canonical usage: `ccairgap exec -- aharness recipe-driven-design.fsm.ts` or `ccairgap exec --agent codex -- aharness recipe-driven-design.fsm.ts`. |
| `doctor` | Agent-aware preflight checks. Defaults to config `agent`, then `claude`; `--agent claude\|codex` overrides config. Shared checks include Docker, state dir, host binaries, image freshness, clipboard, sidecar drift, and user-wide config. The image row resolves the same exact agent versions launch would use from config/CLI `docker-build-arg` values and `CCAIRGAP_CC_VERSION`. Claude checks host Claude credentials and auth-refresh state; Codex checks sanitized `$CODEX_HOME/auth.json` without printing secrets. |
| `inspect` | Enumerate the full config surface ccairgap would see at launch: hook entries, MCP server definitions, `env` vars, and `extraKnownMarketplaces` entries across every source (user `~/.claude/settings.json`, each enabled plugin, `.claude/settings.json[.local]` under `--repo` + every `--extra-repo`, `~/.claude.json`, and `<repo>/.mcp.json`). Output is JSON `{hooks, mcpServers, env, marketplaces}` to stdout; `--pretty` renders human-readable tables instead. Read-only; no session is created and no files are mutated. Accepts the same `--config` / `--repo` / `--extra-repo` inputs as launch plus `--agent`; Codex inspect adds sanitized Codex config/auth/session state and warnings without printing secrets. See §"Hook policy". |
| `init` | Materialize an extension `Dockerfile` (`ARG CCAIRGAP_RUNTIME_BASE_IMAGE=ccairgap:runtime-base-required` / `FROM ${CCAIRGAP_RUNTIME_BASE_IMAGE}` plus final exact agent-version install/checks) and a minimal `config.yaml` (with `dockerfile: Dockerfile`) into `<git-root>/.ccairgap/` — or `dirname(--config)` if `--config` is passed. Fails if either target file exists; `--force` overwrites both. Intended for users who want to customize the container image without forking the repo or copying the raw bundled Dockerfile. See §"Container image customization". |
| `install-completion [<shell>]` | Install shell tab-completion for ccairgap. Writes one `source` line into `~/.bashrc` / `~/.zshrc` / `~/.config/fish/config.fish` (shell picked by arg or prompt). Backed by `@pnpm/tabtab`. Shell completion script offers static subcommand names including `exec`, flag names, plus dynamic candidates: session ids for `recover` / `discard`, custom titles for `--resume` / `-r`, shell names for `install-completion`. See §"Shell completion". |
| `uninstall-completion` | Remove the ccairgap `source` line from every supported shell rc. Idempotent — no-op when not installed. |
| `completion-server` | Internal tabtab callback entry. Invoked by the shell completion function with tabtab's `COMP_*` env vars; emits newline-separated candidates to stdout. Not listed in `--help`; users never call it directly. |

**Examples:**

```bash
# Interactive session: workspace repo + sibling repo + reference dir
ccairgap \
  --repo ~/src/foo \
  --extra-repo ~/src/bar \
  --ro ~/src/docs

# Walk-away (launch inside a host tmux)
tmux new -s work 'ccairgap --repo ~/src/foo'

# Recover an orphaned session
ccairgap list
ccairgap recover 20260417T143022Z

# Force image rebuild
ccairgap --rebuild --repo ~/src/foo

# Run a command in the prepared sandbox
ccairgap exec -- aharness recipe-driven-design.fsm.ts
ccairgap exec --agent codex -- aharness recipe-driven-design.fsm.ts
```

## CLI responsibilities

In order:

1. Parse flags. Resolve `--repo` (single, workspace), `--extra-repo` (repeatable), `--ro` (repeatable), `--base`.
   - If `--bare` was passed, skip every inference and error-on-empty rule below: the user is opting into a naked container. Still require `--repo` before `--extra-repo` (workspace semantics unchanged). See §"Bare mode".
   - Otherwise: if `--repo` is unset and `$(pwd)` is a git repo, default `--repo` to `$(pwd)`.
   - Otherwise: if `--repo` is still unset and `--extra-repo` is non-empty, error: "--extra-repo requires --repo <path> (workspace)."
   - Otherwise: if `--repo` is still unset and `--ro` is non-empty, proceed with no session clone (Claude only gets RO views; no sandbox branch).
   - Otherwise: if `--repo` is still unset and `--ro` is empty, error: "not in a git repo and no --repo / --ro passed."
   - The full repo set is `[--repo, ...--extra-repo]` in that order; the workspace / container cwd is the first entry.
   - Error if the same resolved path appears in more than one of `--repo` / `--extra-repo` / `--ro`.
2. Subcommand dispatch: if the first positional is `list`, `recover`, `discard`, `exec`, `doctor`, `inspect`, `init`, `install-completion`, `uninstall-completion`, or `completion-server`, run that handler per §Recovery / §Doctor / §"Container image customization" / §"Hook policy" / §"Shell completion" / §"Exec command mode" and exit. Any other first positional errors with `unknown command '<x>'` and exit 1 — this prevents typos like `ccairgap lsit` from silently falling through to the launch flow. Launch flags are consumed by the default launch invocation and by `exec` environment preparation.
3. Host-binary preflight: verify `docker`, `git`, `rsync`, and `cp` are all resolvable via PATH (POSIX `command -v`). On failure, error with the list of missing binaries and exit 1 before any session-dir side effects. This catches the ENOENT-during-launch failure mode; `ccairgap doctor` performs the same check plus a `docker version` probe for the daemon.
4. Scan `$XDG_STATE_HOME/ccairgap/sessions/` for orphaned session dirs (dirs without a running container named `ccairgap-<id>`, checked via `docker ps`). If any exist, print a warning banner listing them with suggested `ccairgap recover <id>` / `ccairgap discard <id>` commands. Do not auto-recover; continue to new session setup.
5. Resolve host credentials (see §"Authentication flow"):
   - macOS: run `security find-generic-password -w -s "Claude Code-credentials"`. If the command errors, print "run `claude` on the host to log in, then unlock the keychain" and exit. Otherwise write stdout to `$SESSION/creds/.credentials.json` with mode 0600.
   - Non-macOS: verify host `~/.claude/.credentials.json` exists. If missing, print "run `claude` on the host to log in" and exit.
6. Compute `<id>`, create `$SESSION = $XDG_STATE_HOME/ccairgap/sessions/<id>/`.
7. For each repo in the set (`--repo` plus every `--extra-repo`):
   - `git clone --shared <path> $SESSION/repos/<basename>-<sha256(hostPath)[:8]>`
   - `cd $SESSION/repos/<basename>-<sha256(hostPath)[:8]> && git checkout -b <branch> [<base>]`
   - `<branch>` is always `ccairgap/<id>` where `<id>` is `<prefix>-<4hex>` per §"Session identifier". `--name` supplies the prefix; omitted, a random `<adj>-<noun>` prefix is used. The full ref (`refs/heads/ccairgap/<prefix>-<4hex>`) is validated once via `git check-ref-format`; on collision with an existing session dir, container, or branch in the workspace repo (`--repo`), the hex suffix is re-rolled (up to 8 attempts) before aborting.
8. Record a `$SESSION/manifest.json` capturing the repo→host-path mapping and the chosen `<branch>`, so `ccairgap recover` can reconstruct the fetch targets without re-parsing argv. The manifest **must** start with `"version": 1` (see §"Versioning"). Also record `cli_version`, `image_tag`, and (best-effort) the Claude Code versions on host and in the image for postmortem. Manifests written by older CLI builds omit `branch`; those builds used the `sandbox/` prefix, so the handoff routine falls back to `sandbox/<id>` in that case to keep recover working on pre-existing on-disk sessions.
9. Create `$SESSION/transcripts/` and `$XDG_STATE_HOME/ccairgap/output/` (idempotent).
9a. If `--resume <id-or-name>` was passed: first **resolve the argument to a UUID**. UUIDs (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`) pass through unchanged. Anything else is treated as a **custom title**: the CLI enumerates `~/.claude/projects/<encoded-workspace-cwd>/*.jsonl`, extracts each transcript's last `customTitle` via a head+tail 64 KiB scan (`/rename` and `-n` both append new `custom-title` entries — last-wins), and matches the user's argument case-insensitively. Exactly 1 match → its UUID. 0 matches → abort with `--resume <arg>: no session with that exact name` plus a recency-sorted list of titled candidates. >1 match → abort with `--resume <arg>: N sessions share this name` plus UUIDs for disambiguation. Then locate `~/.claude/projects/<encoded-workspace-cwd>/<uuid>.jsonl` and its sibling `<uuid>/` subagents dir (optional). Copy both (via `cp -a`) into `$SESSION/transcripts/<encoded>/`. If the `.jsonl` is missing, abort launch with `--resume <uuid>: transcript not found at <path>` before any docker interaction. The container receives `CCAIRGAP_RESUME=<uuid>` (resolved form), not the raw arg. The resumed session's `-n` label and rename-hook title use the new session's `<id>` — the prior display name is not preserved.
10. Resolve symlinks (`readlink -f`) for all host paths being mounted: `~/.claude/`, `~/.claude.json`, `~/.claude/CLAUDE.md`, plugin marketplace paths, `--repo` / `--extra-repo` / `--ro` targets.
11. Auto-discover plugin marketplace paths referenced by host `~/.claude/settings.json` (absolute paths outside `~/.claude/`). Add each as a RO mount at its original absolute path.
12. Build `docker run` command:
    - `--rm` (omit if `--keep-container` was passed)
    - `--cap-drop=ALL`
    - `--security-opt=no-new-privileges`
    - `-it` (interactive)
    - `--name ccairgap-<id>`
    - Mount list per §"Container mount manifest"
    - Env vars pushed via `-e`:
        - `NODE_EXTRA_CA_CERTS=/host-ca-certs/<basename>` if the host env var is set and points at an existing file. The file is RO-bind-mounted at that neutral container path (never at the same host absolute path — that risks overmounting the base image's CA trust store). A network policy disables this forwarding, because the sidecar trusts public CAs only.
    - User-supplied `--docker-run-arg` tokens appended after all built-ins (see §"Raw docker run args")
    - Image: `ccairgap:<cli-version>-<sha256(Dockerfile+entrypoint.sh+exact agent versions)[:8]>` by default, or `ccairgap:custom-<sha256(dockerfile+exact agent versions+managed base identity when used)[:12]>` if `--dockerfile` was passed. Build if the tag is missing locally, or if `--rebuild` was passed.
13. Install exit trap: run §"Handoff routine" against `$SESSION/<id>/`.
14. Exec the `docker run` command.

## Exec command mode

`ccairgap exec -- <command...>` is production command-mode plumbing for automation that needs the ccairgap container environment without starting an interactive agent:

```bash
ccairgap exec -- aharness recipe-driven-design.fsm.ts
ccairgap exec --agent codex -- aharness recipe-driven-design.fsm.ts
```

The `--` separator is required. Every token after it becomes the final command argv exactly; ccairgap does no shell parsing and does not run the selected-agent passthrough validators. The command is appended after the Docker image in `docker run` argv and reaches `entrypoint.sh` as `"$@"`.

`--agent` still matters: it chooses which environment is prepared before the command runs. `claude` prepares the Claude-oriented home, credentials, hooks/MCP policy, and overlays. `codex` prepares the Codex home/auth/config/session state in addition to the shared container setup. It does **not** choose the final binary; `ccairgap exec --agent codex -- aharness ...` runs `aharness`, not `codex aharness`.

`--print` and `--resume` are rejected for `exec`, including values loaded from config. Config `claude-args` and `codex-args` are selected-agent passthrough settings, so exec mode ignores them with a warning instead of mixing them into the command argv. There is no `config.yaml` key that persists an exec command tail in this slice.

At Docker runtime, the CLI sets `CCAIRGAP_ENTRYPOINT_MODE=exec`. Missing mode defaults to `agent` for backward compatibility and for direct image runs. Valid values are `agent` and `exec`. `CCAIRGAP_TEST_CMD` remains test-only and is not part of production command mode.

## Config file

YAML file that mirrors launch flags. Default locations (checked in order): `<git-root>/.ccairgap/config.yaml`, then `<git-root>/.config/ccairgap/config.yaml`. Override: `--config <path>` or `--profile <name>`.

- **Load:** the CLI walks up from `cwd` to find the git root; it checks `<git-root>/.ccairgap/config.yaml` first, then `<git-root>/.config/ccairgap/config.yaml`; the first one found is loaded. If both exist, `.ccairgap/config.yaml` takes precedence and a warning is printed to stderr. `--config <path>` skips the walk and loads the given file (absolute or `cwd`-relative); missing file is a hard error.
- **Profiles:** `--profile <name>` loads `<git-root>/.ccairgap/<name>.config.yaml` (fallback `<git-root>/.config/ccairgap/<name>.config.yaml`) instead of the default `config.yaml`. `--profile default` is equivalent to no flag (loads `config.yaml`). Missing profile file is a hard error (unlike the silent walk-fallback for the default). Profile names must match `[A-Za-z0-9._-]+`. `--config` and `--profile` are mutually exclusive. Relative-path anchoring (see §"Relative path resolution") treats profile files identically to `config.yaml` — same canonical-dir detection, so `repo: .` in `web.config.yaml` still means the git root. Profiles are a filename lookup only: no inheritance, no merge between profiles.
- **Key surface:** every launch flag has a config-file key (kebab-case and camelCase both accepted). Unknown keys and wrong types abort launch with a clear error. `src/config.ts` is source of truth. `agent: codex` selects Codex runtime and `codex-args` supplies Codex passthrough tokens. For `exec`, config `agent` applies, config `print` / `resume` reject the invocation, and config `claude-args` / `codex-args` are ignored with a warning.
- **Precedence:** CLI > config > built-in defaults. Scalars: CLI wins if passed. Arrays (`extra-repo`, `ro`, `cp`, `sync`, `mount`, `docker-run-arg`, `hooks.enable`, `mcp.enable`, `claude-args`, `codex-args`): concat (config first, CLI appended; no dedup). Maps (`docker-build-arg`): per-key merge, CLI wins on overlap.
- **`repo` is optional.** If absent, it defaults to the git root that contains the config file (or `cwd` if no config is loaded). Most canonical setups need not set it.

### Relative path resolution

Three anchors, chosen by the semantic of each key. Absolute paths bypass anchoring.

| Keys | Anchor | Rationale |
|------|--------|-----------|
| `repo`, `extra-repo`, `ro` | **Workspace anchor.** When the config lives at either canonical location (`<X>/.ccairgap/config.yaml` or `<X>/.config/ccairgap/config.yaml`), anchor = `<X>` (= the git root). When `--config` points elsewhere (e.g. `/tmp/cfg.yaml`), anchor = `dirname(configPath)`. | These paths describe the user's repo-space — "my repo", "a sibling repo", "the docs dir next to my project". Anchoring on the git root makes `repo: .` mean the workspace, `ro: ../docs` mean a sibling. |
| `dockerfile` | **Config file's directory.** | The Dockerfile is a sidecar file that lives next to `config.yaml`. `dockerfile: Dockerfile` means "the Dockerfile in this same directory". |
| `cp`, `sync`, `mount` | **Workspace repo root**, resolved at launch against the final `--repo` value. Under `--bare`, anchor on CLI `$(pwd)` instead (see §"Bare mode"). | See §"Build artifact paths". These name paths inside the workspace, not paths relative to the config file's location. |

Implementation: `src/config.ts` `resolveConfigPaths` handles `repo`/`extra-repo`/`ro`/`dockerfile`; `src/artifacts.ts` handles `cp`/`sync`/`mount` at launch.

### Example

```yaml
# <git-root>/.ccairgap/config.yaml  (or .config/ccairgap/config.yaml)

# Workspace-space (anchored on git root)
agent: claude             # default; use `codex` to run Codex CLI instead
repo: .                 # optional; defaults to git root anyway
extra-repo:
  - ../sibling          # sibling of git root
ro:
  - ../docs             # sibling of git root

# Sidecar (anchored on config file dir)
dockerfile: Dockerfile  # = <git-root>/.ccairgap/Dockerfile

# Workspace-repo-root anchored (at launch)
cp:
  - node_modules        # = <git-root>/node_modules
sync:
  - dist
mount:
  - .cache

docker-run-arg:
  - "-p 8080:8080"
hooks:
  enable:
    - "python3 *"

# Forwarded verbatim to the in-container `claude` for agent launch mode
# (subject to the denylist in §"Selected-agent arg passthrough").
# Concatenated with the CLI `--` tail. Ignored for `ccairgap exec`.
claude-args:
  - --model
  - opus
  - --effort
  - high

# Forwarded to Codex when `agent: codex`, after fail-closed validation.
# Ignored for `ccairgap exec`.
codex-args:
  - --model
  - gpt-5
```

### `.ccairgap/` scope Claude config

In addition to `config.yaml`, the `.ccairgap/` directory acts as a **ccairgap-scope analog of `.claude/`**: files here are automatically injected into every container session regardless of profile. Aside from `config.yaml`, profile files, and optional `Dockerfile`/`entrypoint.sh` sidecars (host-consumed at launch), the files below are injected into the container only.

| File / dir | Injection semantics |
|---|---|
| `.ccairgap/CLAUDE.md` | Appended (blank-line separator) to `~/.claude/CLAUDE.md` (user-scope) in the container |
| `.ccairgap/settings.json` | Deep-merged into `~/.claude/settings.json` after all other patches. Arrays concatenated (existing first); scalars/objects: ccairgap wins. `null` in ccairgap is a no-op. |
| `.ccairgap/mcp.json` | `mcpServers` merged into `~/.claude.json` user-scope; ccairgap wins on server-name collision |
| `.ccairgap/skills/` | Rsynced into `~/.claude/skills/`; ccairgap wins on skill-name collision |

**Policy bypass (intentional).** `.ccairgap/settings.json` hooks are injected after the `--hook-enable` policy pass; `.ccairgap/mcp.json` servers are injected after the `--mcp-enable` policy pass. Both bypass their respective filters — same design as the built-in session-title hook. These are environment-level policy, not user hooks.

**`--bare` mode.** `.ccairgap/` injection is active in `--bare` mode. It governs session environment, not launch configuration.

**`null` semantics.** A `null` value in `.ccairgap/settings.json` leaves the existing setting unchanged (no-op). To leave a setting unchanged, omit the key.

The same file vocabulary is honored at user-wide scope (`~/.config/ccairgap/`)
with user-wide-first / project-second ordering. The user-wide allowlist is
narrower (no `commands`/`agents`/`hooks` at user-wide — those flow via the
existing `~/.claude/` RO mount + entrypoint rsync). User-wide hooks/MCP via
`settings.json`/`mcp.json` bypass policy filters by design.

### User-wide config layer

A second config layer lives at `$XDG_CONFIG_HOME/ccairgap/` (default
`~/.config/ccairgap/`). Loaded before project config; precedence is
**defaults < user-wide-integrations < user-wide-config < project < CLI**.

User-wide files:

| Path | Role |
|---|---|
| `config.yaml` | Persistent defaults (every `ConfigFile` key except `network` allowed). |
| `<name>.config.yaml` | Reserved (user-wide profiles not loaded). |
| `integrations/*.yaml` | Per-tool drop-ins; `hooks.enable` / `mcp.enable` / `docker-run-arg` only. |
| `CLAUDE.md` | Appended to in-container `~/.claude/CLAUDE.md` before the project block. |
| `settings.json` | Deep-merged into `~/.claude/settings.json` (post policy filter — bypasses `--hook-enable`). |
| `mcp.json` | `mcpServers` merged into `~/.claude.json` (bypasses `--mcp-enable`). |
| `skills/` | Rsynced into `~/.claude/skills/`. |
| `Dockerfile` | Sidecar; opt-in via `dockerfile:` config key. |

Integration files have a structural deny-by-default top-level-key allowlist
(`hooks`, `mcp`, `docker-run-arg`) and a stricter `docker-run-arg` safe-flag
allowlist (`-e`/`--env`, `--add-host`, `--label`, `--dns`, `--dns-search`).
Anything else hard-errors at integration-file load.

Relative `repo`/`extra-repo`/`ro`/`cp`/`sync`/`mount` in user-wide
`config.yaml` are a hard error (no workspace anchor); `dockerfile` anchors
on the user-wide config dir.

## Bare mode

`--bare` launches a container with nothing pre-wired beyond Claude's own config (`~/.claude` RO mount, credentials, plugins cache, `~/.claude.json`). It is the escape hatch for users who want to opt out of every ccairgap convenience and mount exactly what they want.

**What `--bare` turns off:**

- **Config file loading.** Default config discovery (`<git-root>/.ccairgap/config.yaml` / `<git-root>/.config/ccairgap/config.yaml`) is skipped. `--bare` + explicit `--config <path>` or `--profile <name>` is the one exception: the user asked for a specific config, so it loads (CLI wins — `--bare` is about discovery, not suppression).
- **Workspace inference from cwd.** Normal mode defaults `--repo` to `$(pwd)` when cwd is a git repo. `--bare` skips this — the workspace stays unset unless `--repo` is passed explicitly.
- **Empty-session guard.** Normal mode errors when no `--repo` / `--ro` / git-repo-cwd is available. `--bare` proceeds with zero mounts; the user gets a Claude-only container with no host repos or reference material at all.

**What `--bare` does not change:**

- Claude config flow: `~/.claude` RO mount, `~/.claude.json` passthrough, credentials, plugins cache, plugin marketplace discovery, MCP servers — unchanged.
- Authentication flow — unchanged (host login still required).
- Extraction — `/output` is still mounted at `$CCAIRGAP_HOME/output/`, transcripts still flow to `~/.claude/projects/<encoded>/` on exit.
- All other CLI flags — `--repo`, `--extra-repo`, `--ro`, `--cp`, `--sync`, `--mount`, `--docker-run-arg`, etc. all work normally when passed alongside `--bare`.
- `--extra-repo` without `--repo` still errors. Workspace semantics are unchanged; `--bare` only disables inference, not validation.

**Relative path resolution under `--bare`:**

`--cp` / `--sync` / `--mount` relative paths anchor on `$(pwd)` (the CLI invocation cwd), not on the workspace repo root. Rationale: `--bare` is a "do what I say" mode — if the user is running from some directory and passes `--cp foo`, they mean `$(pwd)/foo`. Under normal mode the same invocation would anchor on the workspace repo root, which can differ from cwd. Absolute paths bypass anchoring as usual.

**Examples:**

```bash
# Naked container — just Claude + host config, no repos
ccairgap --bare

# Naked container + one explicit repo
ccairgap --bare --repo ~/src/foo

# Bare mode outside a git repo, with a user-supplied Dockerfile via --config
cd /tmp
ccairgap --bare --config ~/my-cfg.yaml
```

**User-wide layer and `--bare`:**

- `--bare` skips the user-wide layer's `config.yaml` and `integrations/*.yaml`
  (launch config). It does NOT skip user-wide `CLAUDE.md` / `settings.json` /
  `mcp.json` / `skills/` (session environment) — same launch-config-vs-session-environment
  split as project `.ccairgap/`.
- `--no-user-config` is the non-`--bare` kill switch for the entire user-wide
  layer (config + injection mount).

## Container mount manifest

| Host source | Container path | Mode | Notes |
|-------------|----------------|------|-------|
| `~/.claude/` (resolved; `$SESSION/host-claude-placeholder/claude/` — an empty dir — when the host has none) | `/host-claude` | ro | Entrypoint rsyncs contents to `~/.claude/` (settings, plugins minus cache, skills, commands, CLAUDE.md, statusline). `.credentials.json` and `.DS_Store` are excluded from the copy — see the `/host-claude-creds-dir` row for credentials. |
| `$SESSION/host-claude-placeholder/credentials-mask` (empty file; only when host `~/.claude/` holds `.credentials.json`) | `/host-claude/.credentials.json`, or the symlink target inside `~/.claude/` | ro | Hides the host refresh token from the agent. See §"Authentication flow". |
| `$SESSION/claude-symlink-overlay/<rel>/` (host-side materialized) | `/host-claude/<rel>` | ro | One mount per symlink in an allowlisted config path under host `~/.claude/` whose target is outside `~/.claude/`: every absolute symlink, and every relative symlink whose target, resolved lexically from the link's directory, leaves the root (e.g. `skills/foo → ../../.agents/skills/foo`). The container's rsync `-L` runs in the container's mount namespace, where those targets (`/Users/<user>/src/<repo>/skills/foo`, or a path above `/host-claude`) don't exist — the rsync would skip them with "symlink has no referent" warnings. The CLI walks `~/.claude/` host-side, resolves each such symlink via `realpath`, copies the target into `$SESSION/claude-symlink-overlay/<rel>/` with a fixed exclude set (`.git`, `.venv`, `venv`, `node_modules`, `.DS_Store`), and bind-mounts the staged path at `/host-claude/<rel>`. Docker follows the symlink when it creates the mount, so the staged copy lands at the link's target path and `/host-claude/<rel>` stays a symlink. Relative symlinks whose targets stay inside `~/.claude/` need no overlay — they resolve correctly inside `/host-claude`. The scan enters only the top-level names in `CLAUDE_OVERLAY_ALLOWLIST`: `CLAUDE.md`, `settings.json`, `keybindings.json`, `statusline.sh`, `agents`, `agent-memory`, `commands`, `hooks`, `output-styles`, `plugins`, `rules`, `skills`, `themes`, `workflows`. Application data such as `jobs/` can hold symlinks to whole repositories, so the scan does not walk it. `plugins/cache/` is also excluded. A symlink outside the allowlist is not materialized, and its target is absent in the container. rsync exit codes 23 (partial transfer) and 24 (source files vanished) produce a stderr warning, and the launch continues with the partial copy. Other non-zero exit codes abort the launch and remove the session directory. See `src/claudeSymlinkOverlay.ts`. |
| `~/.claude.json` (resolved; `$SESSION/host-claude-placeholder/claude.json` containing `{}` when the host has none) | `/host-claude-json` | ro | Fallback source only — used when the MCP-policy patched copy is absent. Entrypoint normally overlays `/host-claude-patched-json` over this and then applies the jq onboarding patch. |
| `$SESSION/creds/` (always) | `/host-claude-creds-dir` | rw | Directory mount. CLI materializes `.credentials.json` (mode 0600, stripped of `claudeAiOauth.refreshToken`) on every launch and atomically rewrites it on each runtime refresh tick. Entrypoint `ln -sf`s `~/.claude/.credentials.json` to the mounted file so Claude Code's mtime-cache invalidation picks up host-driven rewrites. RW so atomic `rename(2)` succeeds; container writes to anything else in this dir are discarded on exit. See §"Authentication flow". |
| `$SESSION/auth-warnings/` (always) | `/run/ccairgap-auth-warnings` | ro | Directory the host runtime auth-refresh watcher writes warning text into (atomic tmp + rename). The entrypoint's UserPromptSubmit hook reads `current.txt` (when present) and emits it as the top-level `systemMessage` field so failure surfaces inside the running TUI. |
| `$SESSION/hook-policy/user-settings.json` | `/host-claude-patched-settings.json` | ro | Single-file mount. Host-built copy of `settings.json` with `hooks` filtered per `--hook-enable` (empty list → `hooks: {}`) and `disableAllHooks: false` forced. Entrypoint overlays it on the rsync'd `~/.claude/settings.json` before the env-merge jq step. See §"Hook policy". |
| `$SESSION/hook-policy/projects/<repo>/settings.json` (and `.local`) | `<original-host-path>/.claude/settings.json` (and `.local`) | ro | Nested single-file overlay on top of the session-clone's `.claude/` dir. One mount per repo `.claude/settings.json[.local]` that declares hooks. Always present. |
| `$SESSION/mcp-policy/claude-json.json` | `/host-claude-patched-json` | ro | Single-file mount. Host-built copy of `~/.claude.json` with user-scope and every user-project-scope `mcpServers` filtered per `--mcp-enable` (empty list → `mcpServers: {}` at every scope). Entrypoint overlays it in place of `~/.claude.json` before the jq onboarding patch. Always present. See §"MCP policy". |
| `$SESSION/plugin-policy/cache/<market>/<plugin>/<ver>/<rel>` | `/home/claude/.claude/plugins/cache/<market>/<plugin>/<ver>/<rel>` **and** `<host ~/.claude>/plugins/cache/<market>/<plugin>/<ver>/<rel>` | ro | Nested single-file overlays for each enabled cache-backed plugin. `<ver>` is the `installPath` recorded in `~/.claude/plugins/installed_plugins.json`. `<rel>` is each hook/MCP-bearing file: `hooks/hooks.json`, `.mcp.json`, `.claude-plugin/plugin.json`, and each `.json` file the manifest names under `hooks` / `mcpServers`. Claude Code reads plugins at the host-absolute `installPath` (through the host-abs plugins RO mount), so the overlay must cover that path. The second dst collapses into the first when host `~/.claude` equals container `$HOME/.claude`. See §"Plugin policy". |
| `$SESSION/plugin-policy/directory/<market>/<plugin>/<rel>` | `<pluginDir>/<rel>` | ro | Nested single-file overlays for each enabled directory-sourced plugin, at the host path (the marketplace source tree is RO-mounted 1:1). Same `<rel>` set as the cache-backed row. See §"Plugin policy". |
| `$SESSION/mcp-policy/projects/<repo>/.mcp.json` | `<original-host-path>/.mcp.json` | ro | Nested single-file overlay on top of the session clone. One mount per repo whose `.mcp.json` exists. Filtered by glob **and** host approval state — servers approved on host via `enabledMcpjsonServers` / `enableAllProjectMcpServers` and matching the glob survive; everything else is stripped. |
| `~/.claude/plugins/cache/` (resolved) | `/home/claude/.claude/plugins/cache/` | ro | RO-mount stays even after entrypoint copy so this big dir is not duplicated into container FS. |
| `~/.claude/plugins/` (resolved) | `<host-abs-path>/.claude/plugins/` | ro | Second RO mount of plugins tree at the original host absolute path. `known_marketplaces.json` (`installLocation`) and `installed_plugins.json` (`installPath`) store absolute host paths; without a mount at the real host path, Claude Code startup fails with "Plugin X not found in marketplace Y" for `github`/`git`/`npm`/`url`-sourced marketplaces. Skipped when host `~/.claude` coincides with container `$HOME/.claude` (no new path). |
| `$SESSION/transcripts/` | `/home/claude/.claude/projects/` | rw | Transcripts write target. |
| `$SESSION/codex-home/` | `/host-codex` and `/home/claude/.codex` | rw | Session-local Codex home containing filtered config, copied skills, copied installed plugin cache, and copied installed marketplace cache. The neutral helper path is available for entrypoint/debug plumbing; the `$CODEX_HOME` mount is what Codex reads at runtime. Host `$CODEX_HOME` is never mounted directly. |
| `$SESSION/codex-auth/` | `/host-codex-auth` | rw | Session-local sanitized Codex auth directory. Omitted until Codex auth materialization produced state. |
| `$SESSION/codex-auth/auth.json` | `/home/claude/.codex/auth.json` | rw | Sanitized Codex file auth. Mounted as a file over `$CODEX_HOME/auth.json` when present so Codex reads the ccairgap-filtered copy. |
| `$SESSION/codex-sessions/` | `/host-codex-sessions` and `/home/claude/.codex/sessions` | rw | Session-local Codex rollout records. Handoff copies only validated rollout JSONL records back to `<manifest.codex.host_home>/sessions/`. |
| `$SESSION/codex-mcp-credentials/` | `/host-codex-mcp-credentials` | rw | Reserved helper path for a future MCP OAuth credentials design. The first Codex implementation omits MCP OAuth credentials. |
| `$SESSION/codex-home/skills/agents/` or equivalent safe helper root | `/home/claude/.agents/skills` | ro | Optional safe `.agents/skills` guidance root when launch wiring provides one. Plugin/app/MCP integration state is not exposed through this helper. |
| `<effective-host-memory-dir>` (resolved per Claude Code's `autoMemoryDirectory` cascade — see §"Auto-memory") | `/host-claude-memory` | ro | Host auto-memory dir surfaced to Claude Code via `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE=/host-claude-memory` env var. Skipped when the host dir is absent, when no workspace repo is present, or when `--no-auto-memory` is set. Writes fail EROFS; reads (`MEMORY.md`, topic files) succeed. |
| macOS: `/Library/Application Support/ClaudeCode/` / Linux: `/etc/claude-code/` | `/etc/claude-code/` | ro | Managed-policy directory: managed `CLAUDE.md`, `.claude/rules/*.md`, `managed-settings.json`, `managed-settings.d/*.json`, `managed-mcp.json`. Only present when the host dir exists (MDM / enterprise). macOS host path translates to Linux container path — the in-container binary always runs Linux and consults only `/etc/claude-code/`. Skipped on Linux when the dir is absent; skipped entirely on Windows hosts. Interaction with ccairgap's MCP policy: `managed-mcp.json` is **not** filtered by `--mcp-enable`, matching Claude Code's precedence where managed policy overrides user flags. |
| `~/.config/ccairgap/` (resolved) | `/ccairgap-user-dir` | ro | User-wide ccairgap-scope Claude config dir. Skipped when absent. Entrypoint applies its CLAUDE.md / settings.json / mcp.json / skills/ before the project `/ccairgap-dir` overlay. |
| `<workspace-root>/.ccairgap/` | `/ccairgap-dir` | ro | ccairgap-scope Claude config dir. Skipped when absent. |
| `$NODE_EXTRA_CA_CERTS` on host (when set + file exists) | `/host-ca-certs/<basename>` | ro | Corporate TLS CA bundle. Not forwarded under a network policy. The env var is forwarded as `-e NODE_EXTRA_CA_CERTS=/host-ca-certs/<basename>`. Mounted at a neutral container path rather than the host-absolute path so it does not overmount the base image's own CA trust store (`/etc/ssl/certs/*`, `/etc/pki/*`). Symlinks resolved via `realpath()`. Stderr warning + skip when the env var points at a missing file. |
| `$XDG_STATE_HOME/ccairgap/output/` | `/output` | rw | Artifact drop. |
| `$SESSION/repos/<basename>-<sha256(hostPath)[:8]>/` | `<original-host-path>` | rw | Session clone. The `<sha256>` suffix disambiguates multi-repo sessions where two `--repo`/`--extra-repo` paths share a basename. |
| `<resolved-git-dir>/objects/` | `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/objects/` | ro | Alternates target for `--shared` clone. The `<sha256>` suffix disambiguates multi-repo sessions where two `--repo`/`--extra-repo` paths share a basename. The session clone's `.git/objects/info/alternates` is rewritten to this container path so new commits write to the session clone's own RW `objects/` while historical reads resolve through here. See §"Repository access mechanism". |
| `<resolved-git-dir>/lfs/objects/` | `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/lfs/objects/` | ro | LFS content. Session clone's `.git/lfs/objects/` is replaced with a symlink to this path. Mount is optional — skipped if source dir doesn't exist. |
| `<--ro path>` | `<original-host-path>` | ro | Reference material. |
| `<plugin-marketplace-path>` | `<original-host-path>` | ro | Auto-discovered from settings.json. |
| `$SESSION/artifacts/<abs-src>/` (pre-copied from host) | `<original-host-path>` | rw | `--cp` / `--sync` with an absolute source **outside** any repo. Source outside any repo has no covering mount, so the pre-launch copy needs its own bind. For `--cp`/`--sync` sources **inside** a repo, the copy lands inside the session clone and rides on the existing `$SESSION/repos/<basename>-<sha256(hostPath)[:8]>/` mount — no extra entry here. Appended after repo mounts. |
| `<--mount path>` | `<original-host-path>` | rw | User-declared RW bind. Appended after repo mounts so it overrides any session-clone or `--cp`/`--sync` copy at the same path. |
| `$SESSION/clipboard-bridge/` (directory) | `/run/ccairgap-clipboard/` | ro | Host clipboard bridge dir. Omitted when `--no-clipboard` or unsupported host. |
| `$SESSION/network/agent/` | `/run/ccairgap-network/agent` | ro | Network policy only. Holds the forwarder script and the session CA certificate. See §"Network policy". |
| Docker volume `ccairgap-<id>-network` | `/run/ccairgap-network/sock` | ro | Network policy only. Holds the proxy Unix socket. A read-only mount still allows connections to the socket. |

Absolute paths are preserved between host and container so `settings.json` references resolve identically.

### Mount-collision policy

Before invoking `docker run`, ccairgap resolves mount conflicts in two passes:

1. **Marketplace pre-filter (`filterSubsumedMarketplaces`).** If a plugin marketplace path from `extraKnownMarketplaces` equals or is nested inside any `--repo`/`--extra-repo` `hostPath`, the marketplace mount is dropped. The repo's session-clone RW mount serves those files at the same container path. A stderr warning notes the drop and reminds users that the container sees HEAD-only content (uncommitted files in the marketplace tree are not visible).
2. **Collision resolver (`resolveMountCollisions`).** Defense-in-depth at the end of `buildMounts`:
   - Any two surviving mounts sharing a container `dst` throw with both source labels (`--repo/--extra-repo`, `--ro`, `--mount`, `plugin marketplace`, etc.).
   - User-source mounts may not use reserved container paths: `/output`, `/host-claude`, `/host-claude-json`, `/host-claude-creds-dir`, `/host-claude-patched-settings.json`, `/host-claude-patched-json`, `/host-claude-memory`, `/host-codex`, `/host-codex-auth`, `/host-codex-sessions`, `/host-codex-mcp-credentials`, `/ccairgap-dir`, `<home>/.claude/projects`, `<home>/.claude/plugins/cache`, `<home>/.codex`, `<home>/.codex/auth.json`, `<home>/.codex/sessions`, `<home>/.agents/skills`, anything under `/host-git-alternates/`, `/run/ccairgap-auth-warnings/`, `/run/ccairgap-network/`, `/etc/claude-code/`, `/host-ca-certs/`, `/host-codex/`, `/host-codex-auth/`, `/host-codex-sessions/`, `/host-codex-mcp-credentials/`, `<home>/.codex/`, or `<home>/.agents/skills/`.

Nested mounts with distinct `dst` strings (hook/MCP single-file overlays on top of a repo, `--mount` paths inside a repo) are **allowed** — they're the intended overlay mechanism.

Symlinks in `--repo`/`--extra-repo`/`--ro` paths are resolved via `realpath()` before the overlap check, so `--repo /sym --ro /real` (where `/sym → /real`) is correctly caught.

## Build artifact paths

`--cp`, `--sync`, and `--mount` cover the three common shapes for build artifacts (`node_modules`, `.venv`, `target/`, etc.) that are not tracked in git but matter at runtime.

**Resolution rules (shared):**

- Relative paths resolve against the **workspace** repo root (i.e. the first entry of `--repo` + `--extra-repo`). `--cp node_modules` with `--repo ~/src/foo` → source `~/src/foo/node_modules`. Under `--bare`, relative paths anchor on the CLI invocation `$(pwd)` instead — the workspace repo root is not used even when `--repo` is passed. See §"Bare mode".
- Absolute paths are allowed but warn on stderr if they fall outside every declared repo tree.
- The path must exist on host at launch. Missing path → launch aborts.
- Paths are repeatable across flags but not across sources: any given host path may appear in **at most one** of `--repo`, `--extra-repo`, `--ro`, `--cp`, `--sync`, `--mount`. Overlap is a hard error at launch.

**`--cp` (copy-in-discard):**

- Pre-launch: `rsync -a --delete <host-src>/ <session-target>/`.
- Target location: if the source is inside a cloned repo, `$SESSION/repos/<basename>-<sha256(hostPath)[:8]>/<rel>` — the copy rides on the repo's existing RW mount. Otherwise `$SESSION/artifacts/<abs-src>/` with its own RW bind-mount at `<abs-src>`.
- Container writes stay in the session dir. On exit, the session dir is `rm -rf`'d — nothing leaks back to the host.
- Host source is read once at launch and never written.

**`--sync` (copy-in, copy-out-on-exit):**

- Identical setup to `--cp`.
- On container exit, the handoff routine rsyncs `<session-target>/` → `$CCAIRGAP_HOME/output/<id>/<abs-src>/`. Session-scoped (`<id>`) so concurrent sessions don't collide. Absolute-source-preserving so two syncs from different hosts paths (`/a/x`, `/b/x`) both survive.
- The original host path is **never** written. Users who want to promote results back manually `cp -a` from the output tree.
- Recorded in `manifest.json` under `sync` so `ccairgap recover <id>` performs the same copy-out.

**`--mount` (live RW bind):**

- Plain Docker `-v <host>:<container>:rw`. No pre or post copy.
- Container writes land on host immediately. Matches Docker's own mental model.
- Only class of mount that mutates host state during the session. Declared per-path by the user → added to the "host writable paths" closed set as an opt-in category.
- Ordering: `--mount` bind-mounts are appended after repo mounts so they win in Docker's overlap resolution (later mount takes precedence for overlapping container paths). This matters when the mount path nests inside a repo (e.g. `--mount node_modules` with `--repo ~/src/foo`).

**When to choose which:**

- `--cp` when you want a throwaway seed (e.g. test a build starting from a populated `node_modules`).
- `--sync` when you want to keep the result but not let the container poke at the original copy (safer default for "rebuild then hand it back").
- `--mount` when you want live, incremental writes to a persistent host cache (fastest; weakens isolation for that path).

## Clipboard passthrough

ccairgap copies host image-clipboard contents into the container so Claude Code's paste flow works. Unified across host OSes: a host-side watcher process uses the host's native tool to read the clipboard and writes image bytes to `$SESSION/clipboard-bridge/current.png`; that directory is RO-mounted into the container at `/run/ccairgap-clipboard/`; a fake `wl-paste` shim placed by the entrypoint at `$HOME/.local/bin/wl-paste` (ahead of PATH) translates Claude Code's `wl-paste -l` and `wl-paste --type image/png` calls into reads of the bridge file.

**No compositor sockets are mounted into the container.** The container never becomes a Wayland client, gets no X11 display access, and has no way to write back to the host clipboard.

### Verified Claude Code command chain

(From `../claude-code/src/utils/imagePaste.ts`, 2026-04-19.)

- **Linux detection:** `xclip -selection clipboard -t TARGETS -o | grep image/… || wl-paste -l | grep image/…`. Because the image ships no `xclip`, the first call exits 127 and the `||` fallback hits our shim.
- **Linux retrieval:** `xclip -t image/png -o || wl-paste --type image/png || xclip -t image/bmp -o || wl-paste --type image/bmp`. The second stage hits our shim. Claude Code's post-retrieval Sharp pipeline auto-converts BMP → PNG (line 209-217), so the bridge file can contain PNG or BMP — any image format the host clipboard exposes.
- **macOS** uses `osascript` (NSPasteboard via AppleScript). The host-side watcher also uses `osascript` — it is a macOS built-in, so no install is required.
- **No environment-variable gating.** Claude Code does not examine `$WAYLAND_DISPLAY`. ccairgap does not set a `WAYLAND_DISPLAY` sentinel.

### Host-side watcher (per-platform)

| Host | Tool | Strategy | Install hint on missing tool |
|------|------|----------|------------------------------|
| macOS | `osascript` (built-in) | 1 s polling | none — always available |
| Linux Wayland | `wl-paste` | event-driven (`wl-paste --watch`) | `sudo apt install wl-clipboard` |
| Linux X11 | `xclip` | 1 s polling | `sudo apt install xclip` |
| WSL2 | `wl-paste` (via WSLg) | event-driven | `sudo apt install wl-clipboard` |

Detection order: macOS → WSL2 (`/proc/sys/fs/binfmt_misc/WSLInterop` exists) → Wayland (`WAYLAND_DISPLAY` set) → X11 (`DISPLAY` set). macOS always succeeds (osascript is built-in). On Linux/WSL2, when the required tool is missing, the CLI prints a one-line install hint to stderr and runs without clipboard passthrough (equivalent to `--no-clipboard`).

The watcher writes atomically (tmp file → rename). It removes the bridge file when clipboard transitions to non-image content. If the watcher crashes mid-session, its `exit` handler removes the bridge file and logs a warning, so Claude Code never serves a stale image.

### Container plumbing

- `CCAIRGAP_CLIPBOARD_MODE=host-bridge` env — triggers the entrypoint's shim install.
- Mount: `$SESSION/clipboard-bridge/` (directory) → `/run/ccairgap-clipboard/` (RO). Directory mount (not single-file) so `docker run` never hits ENOENT when the clipboard has no image at launch time.
- Shim: `$HOME/.local/bin/wl-paste` — POSIX sh, `case`-based matcher, handles `-l`/`--list-types` and `--type image/png`. Serves bridge bytes regardless of underlying format (PNG/BMP/etc.); Claude Code handles conversion.

### Hard invariant: no `xclip`, no `wl-clipboard` in the image

If `xclip` ends up in the container, Claude Code calls it first (per the verified chain) and clipboard passthrough silently breaks. Enforcement:

- **Static test** (`src/dockerfileInvariants.test.ts`) asserts `xclip` and `wl-clipboard` do not appear as strings in `docker/Dockerfile`.
- **Runtime warning** — the entrypoint emits a stderr warning if `command -v xclip` succeeds when `CCAIRGAP_CLIPBOARD_MODE=host-bridge` is set.

### CLI / config control

- `--no-clipboard` (CLI flag, default: clipboard on) — kill switch.
- `clipboard: false` (config key) — same.
- No-op under `--print`.

### Lifecycle

1. `ccairgap` detects host clipboard mode + tool availability.
2. Before `docker run`, host-side watcher is spawned with a 200 ms start probe.
3. If the watcher fails to start or crashes mid-session, clipboard is disabled with a stderr message; the session continues.
4. `docker run` includes the bridge-dir mount + `CCAIRGAP_CLIPBOARD_MODE` env.
5. On container exit / SIGINT / crash, `launch.ts`'s `finally` block `await`s `clipboard.cleanup()` (SIGTERM → 500 ms grace → SIGKILL) BEFORE handoff. Handoff's session-scratch removal then clears the bridge file.

### Known limitations

- **SSH passthrough depends on topology:**

  | Topology | Works? |
  |----------|--------|
  | Local terminal → local ccairgap | ✓ |
  | Local → SSH → remote Linux (Wayland/X11) | ✗ (watcher reads *remote's* clipboard) |
  | Local → SSH → remote Mac | ✗ (same reason) |
  | Windows Terminal → SSH → WSL2 | ✓ (WSLg bridges Windows clipboard) |
  | Local → `ssh -Y` → remote Linux X11 (ccairgap on remote) | ✓ (remote's `xclip` reads the forwarded X11 clipboard, which is the user's local clipboard) |

  Cross-host clipboard forwarding (lemonade, OSC 52 tmux bridges, etc.) is out of scope. Document in SPEC; no CLI warning.

- **Concurrent sessions share the host clipboard but not the bridge file.** N sessions = N watchers polling the same clipboard. Acceptable for small N.

- **Multi-format clipboards (BMP from Windows via WSLg):** handled by Claude Code's Sharp auto-convert — no extra work in ccairgap.

### Security

See `SECURITY.md` §"Clipboard passthrough risks".

## Container image

**Distribution model:** the CLI tries three sources in order on launch:

1. **Local image** matching the computed tag (`ccairgap:<cli-version>-<hash8>`) — use it.
2. **Registry pull** from `ghcr.io/alfredvc/ccairgap:<cli-version>-<hash8>` (override repo with `CCAIRGAP_REGISTRY=<host>/<owner>/<repo>`). Skipped when `--rebuild` or `--dockerfile` is set, or when the tag is custom (`ccairgap:custom-*`).
3. **Local build** from the Dockerfile shipped inside the npm package (or `--dockerfile <path>`).

The published image is built and signed in `.github/workflows/release.yml`'s `publish-image` job: multi-arch (`linux/amd64`, `linux/arm64`), tagged `ghcr.io/alfredvc/ccairgap:<version>` and `:<version>-<hash8>`, with a SLSA build-provenance attestation pushed alongside the manifest. The workflow also publishes `:<version>-runtime-<runtime-hash8>` and `:<version>-runtime` for generated sidecars. Verify with `gh attestation verify oci://ghcr.io/alfredvc/ccairgap:<tag> --owner alfredvc`. The release job reads exact `CLAUDE_CODE_VERSION` and `CODEX_VERSION` pins from `docker/agent-versions.env`, passes them as Docker build args to the final image, and includes them in the final-image hash in the same order as `computeTag()`. A registry pull either matches the locally computed Dockerfile+entrypoint+agent-version tag or misses and falls back to local build. CLI version mismatch (user has v0.5.0, registry has v0.4.x) or agent-version mismatch → pull misses → local build. When a prior release already published an image with the same `<hash8>` (i.e. `Dockerfile`+`entrypoint.sh`+agent versions unchanged), the workflow retags that digest under the new version via `docker buildx imagetools create` and skips the rebuild — the original attestation still resolves under the new tag.

**Base:** `node:24-slim` (active LTS).

**Installed:**
- Claude Code via the native installer (`https://claude.ai/install.sh`), installed as the `claude` user into `~/.local/bin/claude`. Version controlled via exact `ARG CLAUDE_CODE_VERSION`, resolved from the host (else the `docker/agent-versions.env` pin) or supplied explicitly before image work begins. Native install avoids the npm-to-native-installer migration nag that `@anthropic-ai/claude-code` triggers since v2.1.15.
- Codex CLI via `npm install -g @openai/codex@${CODEX_VERSION}`. Version controlled via exact `ARG CODEX_VERSION`, resolved from the host (else the `docker/agent-versions.env` pin) or supplied explicitly before image work begins.
- `git`, `git-lfs`, `curl`, `jq`, `rsync`, `ca-certificates`, `less`, `vim`.
- `python3`, `python3-pip`, `python3-venv` — common for user scripts and MCP servers. `build-essential` is intentionally **not** installed (~200MB bloat); `pip install` of packages with native deps will fail. Users who need it: `--dockerfile` a customized image.

Apt invocation pattern (all package installs):
```dockerfile
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
    <packages> \
 && rm -rf /var/lib/apt/lists/*
```

`DEBIAN_FRONTEND=noninteractive` suppresses debconf prompts. `--no-install-recommends` keeps image minimal. `rm -rf /var/lib/apt/lists/*` after install strips the package index.

Not installed: `tmux` (user handles tmux outside the container).

**User:** non-root, runs as the host UID/GID. The image bakes `claude` at fixed UID/GID 1000 (renamed from `node:*-slim`'s built-in `node` user) only so the build-time `claude install` step has a non-root user to install under and so `/home/claude` exists with sensible ownership. At runtime the CLI passes `--user $(id -u):$(id -g)`, overriding the baked user — see §"Container UID portability".

Dockerfile (condensed):
```dockerfile
ARG CLAUDE_CODE_VERSION
ARG CODEX_VERSION
RUN test -n "$CLAUDE_CODE_VERSION" && test -n "$CODEX_VERSION"
RUN npm install -g @openai/codex@${CODEX_VERSION}
# node:*-slim ships a `node` user at UID/GID 1000; rename in place. Cosmetic
# only — the runtime user is whatever --user the CLI passes.
RUN groupmod -n claude node \
 && usermod -l claude -d /home/claude -m -s /bin/bash node
USER claude
ENV HOME=/home/claude
ENV PATH=/home/claude/.local/bin:$PATH
RUN curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}"
USER root
RUN mkdir -p /home/claude/.claude/projects /home/claude/.codex/sessions
RUN chmod -R go+rwX /home/claude
ENTRYPOINT ["/usr/local/bin/ccairgap-entrypoint"]
```

No final `USER` — `docker run --user` from the CLI sets the runtime UID directly.

### Container UID portability

The container is launched with `docker run --user $(id -u):$(id -g) --cap-drop=ALL --security-opt=no-new-privileges`. There is no in-container privilege step. Two image-build details make this work for any host UID:

1. **`/home/claude` is world-writable.** The Dockerfile ends with `chmod -R go+rwX /home/claude` (capital `X` adds executable only on already-executable files, so `~/.local/bin/claude` keeps its `+x`). Any runtime UID can read+execute baked content and create new files inside `$HOME`.

2. **Per-session `/etc/passwd` and `/etc/group` are bind-mounted RO.** The CLI generates `$SESSION/userdb/{passwd,group}` with one entry for the runtime UID (named `claude`) and an entry for `root`, then mounts them at `/etc/passwd` and `/etc/group`. Required because libc's `getpwuid()` for an unknown UID returns NULL, and several runtime callers (Node's `os.userInfo()`, git's GECOS lookup, bash's `whoami`) abort or print "I have no name!" when that happens.

Files written from the container to bind-mounted host paths (creds dir, alternates, transcripts, output, clipboard bridge) land owned by the host UID by construction — no chown step required. RO bind-mounts under `$HOME` (host plugin caches, etc.) are untouched. The whole approach is fully compatible with `--cap-drop=ALL --security-opt=no-new-privileges`; previous designs that ran an entrypoint UID-fixup step (`usermod` + `chown -R`) needed `CAP_CHOWN` and broke on Docker Desktop's gRPC-FUSE filesystem — both regressions avoided here.

**Image tagging scheme:**

| Invocation | Tag |
|------------|-----|
| Default | `ccairgap:<cli-version>-<sha256(Dockerfile+entrypoint.sh+exact agent versions)[:8]>` |
| Runtime base | `ccairgap:<cli-version>-runtime-<sha256(runtime-Dockerfile+entrypoint.sh)[:8]>` |
| `--dockerfile <path>` | `ccairgap:custom-<sha256(dockerfile+exact agent versions+managed base image identity when used)[:12]>` |

Both suffixes are deterministic: identical content and identical resolved agent versions always produce the same tag, so rebuilds are skipped when nothing changed. The default tag includes a content hash over both baked files and the exact Claude Code and Codex versions, so edits to either the Dockerfile or `entrypoint.sh` (shipped with a CLI upgrade, or a manual patch) or a host agent-version change produce a new tag and auto-trigger a pull/build on next launch. Custom Dockerfiles that use `ARG CCAIRGAP_RUNTIME_BASE_IMAGE` include the computed runtime base image tag in their identity; host agent-version changes leave that runtime base stable and invalidate only the generated final agent install block. Custom and default tags coexist without collision.

**Rebuild triggers** (the CLI builds the image only if one of these applies):
1. No local image matches the computed tag (covers: first run, CLI upgrade with new version, edits to bundled `Dockerfile` / `entrypoint.sh`, edits to a custom Dockerfile, or changed resolved host Claude Code / Codex versions).
2. `--rebuild` was passed.

The first launch after adding exact agent versions to image identity may build or pull a new image even when an older Dockerfile-content-only tag exists.

Image age is never auto-rebuilt. `ccairgap doctor` surfaces a warning if the current image is older than a threshold (default: 14 days) so the user can explicitly `--rebuild`. `doctor` also lists older `ccairgap:<cli-version>-*` tags that linger after content-hash changes so the user can prune them manually with `docker image rm` — the CLI never removes images itself.

## Container image customization

Two supported paths to change what's inside the image:

1. **`--docker-build-arg KEY=VAL`** — optional escape hatch. The bundled Dockerfile exposes `CLAUDE_CODE_VERSION` and `CODEX_VERSION`, but normal launches resolve both from the host. Pin either agent only when intentionally diverging from the host.
2. **Sidecar Dockerfile via `ccairgap init`** — materialize a small Dockerfile that starts with `ARG CCAIRGAP_RUNTIME_BASE_IMAGE=ccairgap:runtime-base-required` / `FROM ${CCAIRGAP_RUNTIME_BASE_IMAGE}` and installs/checks `CLAUDE_CODE_VERSION` / `CODEX_VERSION` at the end into the config dir (default `<git-root>/.ccairgap/`, or `dirname(--config)` if `--config` is passed). Edit in place by adding only project-specific packages before the generated agent install block. The generated `config.yaml` wires `dockerfile: Dockerfile` so subsequent launches build from the sidecar copy (image tag becomes `ccairgap:custom-<sha256[:12]>` per §"Container image"). No need to fork the repo or copy the raw bundled Dockerfile.

`ccairgap init` writes two files: `Dockerfile` and `config.yaml`. If either exists, `init` aborts with an error listing it; `--force` overwrites both unconditionally (no merge — any prior edits to `config.yaml` are lost). Legacy `entrypoint.sh` sidecars from older versions are ignored by the generated Dockerfile unless the user edits the Dockerfile to reference them.

`ccairgap doctor` treats the current generated extension Dockerfile as up to date, and hash-compares any other sidecar `Dockerfile` / `entrypoint.sh` files against the bundled copies shipped with the installed CLI version. Divergence warns so the user can decide whether to re-run `ccairgap init --force` (destructive; overwrites local `Dockerfile` and `config.yaml`) or keep custom changes.

## Entrypoint

Runs at container start. `CCAIRGAP_ENTRYPOINT_MODE` selects the final branch: missing or `agent` launches the selected agent, and `exec` runs the command argv exactly as supplied after `ccairgap exec --`. Claude remains the default selected-agent branch. When `CCAIRGAP_AGENT=codex`, the entrypoint launches Codex in interactive mode or `codex exec` in print mode after the same home and policy preparation steps; in exec mode it prepares Codex state but still runs the supplied command argv.

Steps:

1. `mkdir -p /home/claude/.claude "$CODEX_HOME" "$CODEX_HOME/sessions"`, with `CODEX_HOME` defaulting to `/home/claude/.codex`.
2. Copy `/host-claude/` → `/home/claude/.claude/` with `rsync -rL --chmod=u+w` (transform symlinks into files, ensure writable in destination). Exclude these session-local entries so we don't drag host state into the container's fresh session view: `projects/`, `sessions/`, `history.jsonl`, `todos/`, `shell-snapshots/`, `debug/`, `paste-cache/`, `session-env/`, `file-history/`. Also exclude top-level `settings.local.json`, anchored as `/settings.local.json` (Claude Code reads it only as project-local settings when the working directory is `$HOME`, so a copy would let `cd ~` load hooks that the hook policy did not filter), and top-level `jobs/`, `daemon/`, `daemon.*` and `daemon-*` (host background-session state, including `daemon/control.key`, `daemon/roster.json` and `daemon.lock`, anchored as `/jobs`, `/daemon`, `/daemon.*` and `/daemon-*` so nested entries of the same name in a skill are kept), `plugins/cache/` (RO-mounted separately at the same container path), `.credentials.json` (handled in the next step), `.DS_Store` (macOS metadata at any depth — often has ACLs that break copies), and `**/.venv/` + `**/venv/` (Python virtualenvs whose `bin/python*` are absolute symlinks into the host interpreter — following them with `-L` fails in-container, and the binaries are host-OS/arch anyway). Before the rsync, scan up to depth 5 for `.venv/`/`venv/` dirs and emit a stderr warning naming each one so the user knows which skills/agents will load with non-functional venvs. Symlinks in allowlisted config paths under `~/.claude/` whose targets are outside `~/.claude/` (absolute, or relative with `..` past the root) would also fail rsync `-L` in the container namespace (their targets don't exist there), so the CLI pre-materializes each one host-side and mounts the result at `/host-claude/<rel>`. Docker follows that symlink when it creates the mount, so the materialized copy lands at the link's target path (for example `/Users/<user>/src/<repo>/skills/foo` or `/.agents/skills/foo`) and `/host-claude/<rel>` stays a symlink. The target now exists in the container, so the entrypoint rsync `-L` copies the materialized content. See §"Container mount manifest" and `src/claudeSymlinkOverlay.ts`. rsync exit codes 23 ("some files/attrs not transferred") and 24 ("some source files vanished") are tolerated with a warning to cover any remaining stragglers (e.g. a relative symlink pointing into an excluded subtree, or a symlink outside the overlay allowlist); other exit codes still abort.
3. If `/host-claude-creds-dir/.credentials.json` exists, `ln -sf /host-claude-creds-dir/.credentials.json /home/claude/.claude/.credentials.json`. The symlink (rather than `cp`) lets upstream's mtime-cache invalidation (`auth.ts:1320`) observe host-driven runtime rewrites of the bind-mounted file.
4. Copy `~/.claude.json` source → `/home/claude/.claude.json`. The MCP-policy overlay wins: if `/host-claude-patched-json` is mounted (strips user + user-project `mcpServers` per `--mcp-enable`), use it as the source; otherwise fall back to `/host-claude-json`. See §"MCP policy".
5. Patch `/home/claude/.claude.json` via `jq` to ensure:
   - `hasCompletedOnboarding: true`
   - `projects.<cwd>.hasTrustDialogAccepted: true` for each session repo's cwd
   - `installMethod` and `autoUpdatesProtectedForNative` deleted (the container runs a native install at `/home/claude/.local/bin/claude`; deleting these fields lets Claude Code re-detect its install method from the binary path rather than inheriting stale host values)
6. If `/host-claude-patched-settings.json` exists, `cp -L` it over `/home/claude/.claude/settings.json` before proceeding. This is the hook-policy overlay: a host-built copy of `settings.json` with `hooks` filtered per `--hook-enable` (empty list → `hooks: {}`) and `disableAllHooks: false` forced (so the custom `statusLine` survives). The next step's env merge layers on top of the filtered hooks.
7. Merge overrides into `/home/claude/.claude/settings.json`. `.env` merged with `jq '.env = (.env // {}) + { ... }'` to preserve existing entries; `skipDangerousModePermissionPrompt` set to `true` to suppress the bypass-permissions startup warning inside the sandbox; `disableAgentView` set to `true` to turn off Claude Code background sessions and agent view by default (see §"Environment variables"):
   ```json
   {
     "env": {
       "DISABLE_AUTOUPDATER": "1",
       "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
       "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1"
     },
     "skipDangerousModePermissionPrompt": true,
     "disableAgentView": true
   }
   ```
8. Apply the `.ccairgap/` scope overlay — see §"`.ccairgap/` scope Claude config" for the full contract. `.ccairgap/CLAUDE.md` is appended to `~/.claude/CLAUDE.md`, `.ccairgap/settings.json` is deep-merged into `~/.claude/settings.json`, `.ccairgap/mcp.json` `mcpServers` are merged into `~/.claude.json`, and `.ccairgap/skills/` is rsynced into `~/.claude/skills/`. Overlay steps run after the hook-/MCP-policy passes so ccairgap-scope entries bypass `--hook-enable` / `--mcp-enable` by design.
9. If no `--repo` was passed (ro-only session), cwd defaults to `/workspace` (simple fallback). Otherwise cwd = `--repo`'s preserved path (the workspace). `--extra-repo` entries are mounted at their preserved paths but never become cwd.
10. If `CCAIRGAP_ENTRYPOINT_MODE=exec`, set the final command to `"$@"` after setup. This is the production command-mode path. The CLI requires at least one command token and passes the command argv unchanged; the entrypoint performs no shell parsing. Missing mode defaults to `agent`; unknown mode exits with an error.
11. Build the final selected-agent args:
   - **Claude branch:** always `claude --dangerously-skip-permissions`; then label, resume, passthrough, and optionally print.
   - **Label (`-n`):** `CCAIRGAP_NAME` carries the session id (always set by the CLI). Use `-n "ccairgap $CCAIRGAP_NAME"`. Fallback to `-n "ccairgap"` only when `CCAIRGAP_NAME` is unset (i.e. the entrypoint was launched directly without the CLI env).
   - **Resume (`-r`):** if `CCAIRGAP_RESUME` is set, append `-r "$CCAIRGAP_RESUME"`.
   - **Passthrough (`"$@"`):** the CLI appends filtered claude-args as positional args to `docker run`; they arrive at the entrypoint as `"$@"` and are spliced verbatim. Filtered host-side; the entrypoint does not re-validate. See §"Selected-agent arg passthrough".
   - The `-n` value (`"ccairgap <id>"`) is intentionally **not** the same as the UserPromptSubmit hook's `sessionTitle` output (`"[ccairgap] <id>"`): Claude Code's hook layer dedups against the current title, so if `-n` already matched the hook output, the rename would skip and the TUI's "session renamed" side effects (TextInput border recolor, top-border label) would never fire.
   - Then either `-p "$CCAIRGAP_PRINT"` for non-interactive print mode, or nothing for the interactive REPL. `exec claude …`. `-p` stays the final positional so claude treats `$CCAIRGAP_PRINT` as the prompt argument (claude's prompt-positional convention).
   - **Codex interactive branch:** `codex --dangerously-bypass-approvals-and-sandbox --no-daemon --cd "$CCAIRGAP_CWD" "$@"`. `--no-daemon` runs Codex without its shared background server. That server needs `ps`, which the image does not contain, and ccairgap keeps background servers off.
   - **Codex print branch:** `codex exec --dangerously-bypass-approvals-and-sandbox --cd "$CCAIRGAP_CWD" "$@" "$CCAIRGAP_PRINT"`.
12. If `CCAIRGAP_ENTRYPOINT_DRY_RUN=1`, print the selected branch, cwd, `CCAIRGAP_ENTRYPOINT_MODE`, `CCAIRGAP_AGENT`, optional `CCAIRGAP_PRINT`, `CODEX_HOME`, home readiness, and final shell-quoted command, then exit before `exec`. This is test-only and differs from `CCAIRGAP_TEST_CMD`, which exits before branch selection.

## Auto-memory

Claude Code's auto-memory feature persists rolling per-workspace notes to `<autoMemPath>/MEMORY.md` plus a set of topic files. ccairgap surfaces the host's existing memory dir into the sandbox read-only.

**Host-side resolution** (matches `claude-code/src/memdir/paths.ts:161-235`):

1. `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE` env var (absolute path, no tilde expansion) — wins outright.
2. `autoMemoryDirectory` in `<managedPolicyDir>/managed-settings.json` (when the managed-policy dir is present on host).
3. `autoMemoryDirectory` in `<workspaceHostPath>/.claude/settings.local.json`.
4. `autoMemoryDirectory` in `<hostClaudeDir>/settings.json`.
5. Fallback: `<hostClaudeDir>/projects/<sanitizePath(canonical-repo-root)>/memory/` where `canonical-repo-root` is the main repo's working directory (worktrees resolve to the canonical root, matching Claude Code's `findCanonicalGitRoot`), and `sanitizePath` replaces every non-alphanumeric character with `-` (truncating to 200 chars + appending a djb2 hash for longer inputs).

`<workspaceHostPath>/.claude/settings.json` (the repo-committed project settings) is **not** consulted — matches Claude Code's security carve-out against a malicious repo setting `autoMemoryDirectory: "~/.ssh"`.

**Container-side:** the resolved host dir is RO-bind-mounted at `/host-claude-memory`, and `CLAUDE_COWORK_MEMORY_PATH_OVERRIDE=/host-claude-memory` is injected via `-e` so Claude Code treats it as the full-path override (highest priority in its own chain). No nested bind mounts, no symlinks, no entrypoint participation.

**Skip triggers:** `--no-auto-memory` flag, `no-auto-memory: true` config key, no workspace repo, resolved path does not exist, or path does not pass Claude Code's validation (bare tilde forms, relative paths, sub-3-character paths).

## Authentication flow

Credentials come from the host's existing Claude Code login. At launch the CLI runs a three-step pipeline: read host creds → pre-launch refresh (best-effort, lock-coordinated) → materialize a **stripped** session creds file. The container always receives a creds file with `claudeAiOauth.refreshToken` removed, so its Claude Code never refreshes in place and can't race host or peer containers for the refresh-token rotation window (RFC 9700 §4.13).

**Step 1 — Read host creds.**
- **macOS:** `security find-generic-password -w -s "Claude Code-credentials"` → JSON string.
- **Linux / other:** `readFile(~/.claude/.credentials.json)` → JSON string.

**Step 2 — Pre-launch refresh (best-effort).** Uses the `proper-lockfile` library on host `~/.claude/` (same library/path Claude Code acquires in `src/utils/auth.ts:1491`). If the token's remaining ttl falls below `--refresh-below-ttl` minutes (default 120), the CLI:

1. Acquires a `proper-lockfile` on host `~/.claude/` (stale: 10s, 5 retries with exponential backoff).
2. Re-reads host creds inside the lock. If another writer refreshed while we waited, action = `already-fresh` and we skip the refresh call (benign race-loss).
3. Otherwise invokes `claude auth login` on the host with env vars `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` (Claude Code's supported fast-path — upstream `src/cli/handlers/auth.ts:140-186`). `stdin: "ignore"`, 120 s timeout.
4. Re-reads host creds post-call → authoritative ttl.
5. Releases the lock.

Any running host `claude` mid-refresh waits for our lock, and vice versa.

**Step 3 — Strip and materialize.** The authoritative post-refresh JSON is parsed, `claudeAiOauth.refreshToken` is deleted, and the result is written to `$SESSION/creds/.credentials.json` (mode 0600) via atomic tmp + `fsync` + `rename(2)`. The enclosing `$SESSION/creds/` directory is bind-mounted RW at `/host-claude-creds-dir` on every platform — RW so the runtime watcher's atomic rename succeeds; container writes to anything else in the dir are discarded on exit. The `ccairgap` session dir (and so the stripped file) is deleted on exit.

**Step 4 — Runtime refresh.** While `docker run` is alive, the CLI ticks once per minute (`setInterval(60_000)`) on its main event loop. Every tick calls the same `refreshIfLowTtl` helper used at pre-launch (with `refreshBelowMs = 31 min`) — `refreshIfLowTtl` short-circuits to `action: "fresh"` cheaply when ttl is above the threshold (one keychain read, no lock acquisition), and only acquires the lock + refreshes when ttl drops. After each ok return the watcher computes `stripRefreshToken(host)` and rewrites `$SESSION/creds/.credentials.json` (tmp + `fsync` + `rename(2)`) **only when the stripped bytes differ from the last write** — keeping fsync churn off the steady-state path. The container's Claude Code picks up changed content through its `invalidateOAuthCacheIfDiskChanged` mtime check (`auth.ts:1320`) on the next API request — no in-container coordination required.

The unconditional per-tick host read serves a second purpose: **host-driven account swap propagation**. If the user runs `/login` on the host and switches account mid-session, host creds rotate but the session creds file stays on the old token until natural expiry. Reading host every tick and writing on stripped-content diff propagates the new account's access token to the bind-mounted session file within ≤60 s. The user explicitly requested the swap, so propagation is silent (no banner). Upstream Claude Code's main inference path in `services/api/client.ts:132` proactively calls `checkAndRefreshOAuthTokenIfNeeded` → `invalidateOAuthCacheIfDiskChanged` before each request, so the next API call uses the new token; the `withRetry.ts:241-251` 401-recovery path also rebuilds the API client from disk after `handleOAuth401Error` clears the cache, so any in-flight request that 401s on the old token self-heals on retry. The `bridge/bridgeApi.ts:124-138` connector path is a partial exception — its 401 handler returns `false` on stripped creds (no `refreshToken`) and surfaces one `BridgeFatalError` to the in-flight bridge call before subsequent calls see fresh creds. Acceptable: bridge connector errors are user-visible and recoverable.

**Mtime mismatch handling.** The watcher records the post-write mtime; on a tick that observes a different mtime it reads the file once and inspects `claudeAiOauth.refreshToken`:

- **`refreshToken` present** — in-container `/login` recovery (Claude Code just completed OAuth in-container and wrote a full creds JSON to the bind-mounted file). The watcher cedes control for the rest of the session because the container's user deliberately introduced a container-scoped refresh chain that must not be clobbered with stripped host creds.
- **`refreshToken` absent** — a host-side external writer (manual `cp` recovery, peer ccairgap session, third-party tool). All host-driven writes are stripped by definition. The watcher adopts the new content as its baseline (`lastWriteMtimeMs`, `lastWrittenStrippedJson`, `expiresAtMs`) and continues mirroring host on subsequent ticks so future host refreshes still propagate. This preserves the `session creds == host creds (modulo refreshToken)` invariant across the recovery write; the older "always cede on mtime change" rule allowed a host-side recovery to permanently sever mirroring until CLI restart.

**Tick-boundary throw classification.** A throw inside `refreshFn` (most commonly `readHostCredsJson` failing — locked macOS keychain after sleep, missing `claude` on the watcher's PATH, etc.) is caught at the IIFE boundary, classified `unknown`, fed through the existing fail-banner / state-file path, and **does not stop the watcher**. The 60-s `setInterval` keeps firing so transient host-read errors self-heal once the host becomes readable again. Without this catch, the previous code path swallowed the rejection via `void tick()` — no state write, no warning, no retry counter increment, leaving the session silently un-mirrored.

**Failure surfacing.** Three consecutive failures, or any failure with under 15 minutes of remaining ttl, writes `$SESSION/auth-warnings/current.txt` (atomic tmp + rename, so the in-container `cat` cannot read a torn file). The bind-mounted file is read by the entrypoint's UserPromptSubmit hook on the next prompt and emitted as the top-level `systemMessage` field, so the failure shows inside the TUI without competing for stderr that the alt-screen has hidden. Each tick also writes `$SESSION/auth-refresh-state.json` for `ccairgap doctor`.

**`--print` caveat.** The hook fires on `UserPromptSubmit`, which never fires under `claude -p`. Walk-away `--print` runs therefore see refresh failures only as host-side stderr messages (post-mortem). The runtime watcher still ticks under `--print` so the access token stays fresh — only the in-TUI banner mechanism is interactive-only.

**CLI shutdown.** The `finally` block that runs `clipboard.cleanup()` first calls `refreshHandle.stop()`, which clears the timer and awaits an in-flight refresh. Bounded latency: 120 s (the `claude auth login` timeout from `authRefresh.ts`).

**UX branches.**

- **Success / fresh:** no banner. Action is `fresh` (ttl above threshold), `already-fresh`, or `refreshed`.
- **Soft failure** — refresh call failed but the existing access token still has ≥5 min of life. Launch proceeds; stderr banner names the failure reason and tells the user to `/login` in Claude when the token expires mid-session:
  ```
  ⚠ Auth refresh failed: <reason>. Token expires HH:MM (Xm).
    When it hits: Claude will error. Run /login in Claude to recover.
  ```
- **Hard failure (cold-start-dead)** — refresh failed AND final ttl < 5 min. The CLI refuses to launch and throws `CredentialsDeadError` before any session dir is materialized:
  ```
  ✗ Host auth is dead (<reason>; <Xm> left).
    Run `claude` on host to re-login, then retry ccairgap.
  ```
  Rationale: below the 5-min floor the container's Claude Code would 401 on its first API call and cycle the upstream `withRetry` 10× before giving up. A clean launch-time refusal is better UX.

**Failure classification** (`<reason>` text in the banners):

| Classification | Trigger | Reason text |
|---|---|---|
| `revoked` | stderr matches `/invalid_grant/` | `refresh token revoked` |
| `network` | stderr matches `/ENOTFOUND\|ETIMEDOUT\|ECONNREFUSED\|getaddrinfo\|network/i` | `network error contacting Anthropic` |
| `binary-missing` | spawn errors with `ENOENT` | `claude not on PATH` |
| `timeout` | `execa` timeout fires | `claude auth login timed out after 120s` |
| `expired` | no refresh attempted (e.g. `--refresh-below-ttl 0`) but final ttl < 5 min | `host token near expiry` |
| `unknown` | any other non-zero exit | first line of stderr (truncated to 120 chars) |

**In-container behavior.** Claude Code's refresh path short-circuits at `!tokens?.refreshToken` (upstream `src/utils/auth.ts:1459`) so it never contacts Anthropic's token endpoint. Mid-session expiry: the next API request returns 401 and the upstream 401 handler returns `false` (`auth.ts:1380-1382`) because there is no refresh token to rotate — `withRetry` cycles up to 10× then throws. The user types `/login` in the TUI, completes the paste-code OAuth flow, and Claude Code writes a fresh container-scoped token pair into `~/.claude/.credentials.json`. The session continues with that new chain until exit.

The `/host-claude` RO mount covers all of `~/.claude/`, so a host credentials file is inside it. The CLI mounts an empty session-scratch file over that path, and over the target when the file is a symlink inside `~/.claude/`. The stripped session file is the only creds source the container sees. A symlink target outside `~/.claude/` has no path in the container. The entrypoint rsync also excludes `.credentials.json`.

**Operator notes.**

- Log in on the host once with `claude` (normal host login). `ccairgap doctor` prints the current token ttl + OAuth scopes.
- `--refresh-below-ttl 0` disables the pre-launch refresh; the cold-start-dead refusal still fires when the host token is already below the 5-min floor.
- To switch accounts, log in differently on the host before launching. Multi-profile support is out of scope.
- The container's `~/.claude/` is writable (normal home dir), so session mutations (permission cache, prompt history in `.claude.json`) stay in-container and die with it — host state is untouched.

## Repository access mechanism

Uses `git clone --shared`: session clone stores only refs + new commits; existing objects resolved via `.git/objects/info/alternates` pointing at host repo's RO-mounted object dir.

**Alternates rewrite:**

`git clone --shared` writes an `alternates` file containing the host's real `.git/objects/` path. That path is not meaningful inside the container, and mounting the host's `objects/` at `<hostPath>/.git/objects/` would shadow the session clone's own (RW) `objects/` directory — blocking all new commits. Instead:

1. The host's `.git/objects/` is RO-mounted at a neutral container path: `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/objects/`.
2. The CLI rewrites the session clone's `.git/objects/info/alternates` (host-side, post-clone) to contain `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/objects`.

   The `<sha256(hostPath)[:8]>` suffix disambiguates multi-repo sessions where two `--repo`/`--extra-repo` paths share a basename (e.g. `/a/myrepo` and `/b/myrepo` both named `myrepo`). Without this suffix, both would mount at `/host-git-alternates/myrepo/objects`, which Docker rejects as a duplicate mount point.

3. Inside the container, `<hostPath>/.git/objects/` is the session clone's own RW `objects/`. New commits write there; git resolves historical objects via the alternates file.

LFS gets the same pattern: host `lfs/objects/` at `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/lfs/objects/`, and the session clone's `.git/lfs/objects/` is replaced with a symlink to that path.

**Resolving the real git dir:**

For each repo in the set (`--repo` plus every `--extra-repo`), the CLI determines the real `.git/` location before setting up mounts:

1. If `<path>/.git` is a directory: real git dir is `<path>/.git/`.
2. If `<path>/.git` is a file (worktree): read it, extract the `gitdir:` line, follow to the main repo's `.git/worktrees/<name>/`. Walk up to the main repo's `.git/` dir (the parent of `worktrees/`). Real git dir is that main `.git/`.
3. Otherwise: error, not a git repo.

The resolved git dir's `objects/` subdir becomes the RO mount source. `--shared` clone handled automatically by git (it follows worktree pointers when resolving the source).

**LFS:**

If `<resolved-git-dir>/lfs/objects/` exists on the host, it is additionally RO-mounted at `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/lfs/objects/` in the container, and the session clone's `.git/lfs/objects/` is replaced with a symlink to that mount path (same pattern as the alternates `objects/` mount — neutral container path keeps the session clone's own RW space uncovered). `git-lfs` binary is installed in the container. Checkout/smudge in the session clone resolves LFS content from the mount without network fetches.

If the dir doesn't exist (repo doesn't use LFS), the mount is skipped. Never fatal.

**Isolation:**
- Session clone is RW; host repo's git metadata is RO-mounted at a neutral container path (only `.git/objects/` and optionally `.git/lfs/objects/`; working tree and refs are not).
- Any attempt to write to those RO mounts fails at kernel level.
- Commits by the container go into the session clone's own `.git/objects/` (at `<hostPath>/.git/objects/` inside the container) — never touch host.

**Exit handoff:**
- On container exit, the CLI runs `git -C <real-host-path> fetch $SESSION/repos/<name> ccairgap/<id>:ccairgap/<id>` — but only if the sandbox branch has commits the host doesn't already have (see §"Handoff routine" for the empty-branch skip and orphan-branch preservation).
- This happens on the host, not in the container. Container never has write access to the real repo.
- Result: a new branch `ccairgap/<id>` in the host repo containing Claude's commits. If the session made no commits, no branch is created. Host user reviews / merges / discards.
- A branch checked out in a linked worktree of the session clone (for example a subagent with `isolation: worktree`) arrives as `ccairgap/<id>-worktrees/<branch>`. The extra path segment is required because git cannot hold both `ccairgap/<id>` and `ccairgap/<id>/<branch>`. A session id always ends in a 4-hex suffix, so `<id>-worktrees` cannot be another session's id.

**Host constraints during session:**
- Do not run `git gc --prune=now` or `git prune` on the real repo — would delete objects the session clone references via alternates.
- Routine operations (checkout, commit, push, fetch, rebase, reset, auto-gc) are safe. The session clone has its own refs; host ref movement doesn't affect it.

## Git identity passthrough

Container needs `user.name` / `user.email` or `git commit` fails (`Author identity unknown`) and work is lost on handoff (fetch only moves reachable commits).

- CLI reads host identity at launch: `git -C <--repo[0]> config --get user.name` and `user.email` (local → global precedence, so repo-local overrides work). Falls back to process cwd if no `--repo`.
- Identity is passed to the container via env: `CCAIRGAP_GIT_USER_NAME`, `CCAIRGAP_GIT_USER_EMAIL`.
- Entrypoint runs `git config --global user.name "$CCAIRGAP_GIT_USER_NAME"` + `user.email` at container start.
- If host has neither local nor global identity: CLI warns on stderr and falls back to `ccairgap <noreply@ccairgap.local>` so commits still succeed. User rewrites author on the sandbox branch post-hoc if needed (`git rebase --exec 'git commit --amend --reset-author --no-edit'` or `git -c user.name=... -c user.email=... commit --amend`).
- GPG / SSH signing is not supported inside the container (no keys). If host has `commit.gpgsign=true`, user must unset it for the sandbox branch or accept that the container will error on commit. The CLI does not override signing config — `~/.gitconfig` is not mounted in this passthrough mode.

## Transcripts

- Claude writes session transcripts to `~/.claude/projects/<path-encoded-cwd>/` inside the container.
- `<path-encoded-cwd>` is the absolute cwd with `/` replaced by `-`. Example: cwd `/Users/alfredvc/src/foo` → dir `-Users-alfredvc-src-foo`. This is deterministic encoding, not a hash; same path always produces the same dir name.
- The directory contains a flat `<session-uuid>.jsonl` main transcript plus an optional sibling `<session-uuid>/` dir for subagent content (present only when the session spawned subagents). The subagent dir holds `subagents/<agent-id>.jsonl` and `subagents/<agent-id>.meta.json` pairs. A per-project `permissions_log.jsonl` sits alongside the main file and is cross-session.
- The `projects/` path is a bind mount of an empty-per-session host dir: `$SESSION/transcripts/`. Container sees only its own session's transcripts — no read, modify, or delete access to older ones.
- On container exit, the CLI's exit trap recursively copies each `$SESSION/transcripts/<path-encoded-cwd>/` into host `~/.claude/projects/<same-dir-name>/` using `cp -r` (or `rsync -a`). Merging with any existing host content is safe — session UUIDs in nested dir names are unique.
- Because container preserves host absolute paths for repo cwds, the encoded dir name matches between container and host — `claude --resume` on the host finds the transcript naturally.
- Session dir is deleted after successful copy.
- **Concurrent resume is last-writer-wins.** If you `ccairgap -r <uuid>` while a host `claude -r <uuid>` is also running in the same cwd, both processes append to their own copies of `<uuid>.jsonl`; on ccairgap exit, the handoff copy-back overwrites whatever the host wrote in the meantime. Don't run the same session id in two places simultaneously — pick one.

## Raw docker run args

`--docker-run-arg` is an escape hatch for users who need docker features the CLI does not (yet) surface as dedicated flags: publishing ports, extra env vars, attaching to a custom network, mounting additional volumes, overriding defaults, etc.

**Parsing:**

- Each `--docker-run-arg <value>` value is shell-split with [`shell-quote`](https://www.npmjs.com/package/shell-quote). `"-p 8080:8080"` becomes two tokens; `'--label "key=val with space"'` becomes `--label` + `key=val with space`.
- Non-literal shell constructs (operators `&&`/`|`, subshells, globs) are rejected at launch: these must be literal docker tokens.
- Repeatable; tokens from each invocation concatenate in order.
- Config file key: `docker-run-arg: [<string>, …]`. Concat merge with CLI (config entries first, CLI appended).

**Ordering:**

- Built-in args come first: `docker run --rm -it --cap-drop=ALL --name … -e … -v …`.
- User tokens are appended after all built-ins, before the image tag.
- Docker resolves repeatable flags with last-wins semantics, so `--docker-run-arg "--network my-net"` overrides no built-in network flag (there is none without a network policy), while `--docker-run-arg "--cap-drop NET_ADMIN"` narrows the earlier `--cap-drop=ALL`.

**Danger warning:**

- Before invoking docker, the CLI scans the parsed tokens for flags known to weaken default isolation: `--privileged`, `--cap-add`, `--security-opt`, `--device`, `--network=host` / `--net=host`, `--pid=host`, `--userns=host`, `--ipc=host`, `--uts=host`, substring `docker.sock`, substring `SYS_ADMIN`, and any `--cap-drop` narrower than `ALL`. Two-token forms (`--network host`, `--cap-add SYS_ADMIN`) are caught alongside the `=host` forms.
- Each hit prints one stderr warning naming the token and the broad reason. The launch still proceeds — this is a nudge, not a gate.
- Scan is best-effort; users can construct equivalent effects via args the scan does not know about. The CLI makes no claim of completeness.
- Silence the warning with `--no-warn-docker-args` (or `warn-docker-args: false` in config).

**Relation to a network policy:** when the `network` key is active, the CLI rejects network and isolation flags. See §"Network policy".

**Relation to the host-writable-paths invariant:**

- Raw args that add RW mounts (`-v <host>:<ctr>:rw`, `--mount type=bind,source=<host>,...`) expand the writable-paths set beyond what the CLI can see. §"Host writable paths" item 6 records this formally.
- Raw args are appended after all built-in mounts. Docker's own last-wins behavior can therefore override ccairgap-controlled mounts, including reserved Codex paths. Reserved-path collision checks apply only to structured ccairgap inputs (`--repo`, `--ro`, `--mount`, `--cp`, `--sync`, discovered marketplaces), not raw `--docker-run-arg` tokens.
- Users who only want per-path host RW should prefer `--mount <path>` — it's narrower in semantics and stays within the structured flag surface.

## Selected-agent arg passthrough

For the default launch command and `attach`, ccairgap treats tokens after CLI `--` as the selected-agent passthrough tail. Claude remains the default selected agent. With `agent=claude`, ccairgap forwards `claude` launch flags it does not own from CLI `--` and config `claude-args:` to the in-container `claude` invocation. Forward-compatible: any flag not on the denylist below passes through verbatim, so new Claude Code flags work the day they ship without a ccairgap release.

With `agent=codex`, ccairgap merges config `codex-args:` and the CLI `--` tail, validates them with the Codex mode-aware allowlist, verifies container-visible `--image` paths, and forwards the filtered argv to the in-container Codex invocation.

**Sources:**

- **CLI:** tokens after a bare `--` are the passthrough tail for default launch and `attach`. Example: `ccairgap --repo . -- --model opus --effort high`. The pre-split runs in `src/cliSplit.ts` before commander parses, so the existing unknown-positional guard still catches typos like `ccairgap lsit`. `exec` uses the same separator for exact command argv instead of selected-agent passthrough. `--` passthrough on other known subcommands (`list`, `recover`, `discard`, `doctor`, `inspect`, `init`, completion commands) errors.
- **Config:** `claude-args: [<token>, …]` in YAML (kebab and camelCase aliases both accepted). Same shape as the CLI tail: a list of literal tokens. No map form — `claude-args: {model: opus}` is rejected by `assertStringArray`.
- **Codex config:** `codex-args: [<token>, …]` in YAML (kebab and camelCase aliases both accepted). Used when `agent=codex`; config tokens come before the CLI tail and are validated with the Codex passthrough allowlist before launch.
- **Merge:** config tokens come first, CLI tokens append. Claude's last-wins arg parser handles duplicates; users can rely on that to override config values from the CLI (config sets `--model opus`, CLI passes `-- --model sonnet` → claude keeps the last).

**Plumbing:** the merged + filtered list is appended as positional args to `docker run`. Docker forwards them to the entrypoint as `"$@"` (execve-style — no shell parsing, no JSON layer). The entrypoint splices `"$@"` into the selected agent command: after Claude's built-in launch args, after Codex's built-in `codex` launch args, or before the final prompt for Codex print mode. Argv (not env-var JSON) avoids serialization layers and the per-env-var size cap; values with spaces, quotes, or newlines round-trip unchanged.

**Filtering** runs in `src/claudeArgs.ts` for Claude and `src/codexArgs.ts` for Codex. Hard-denied flags abort launch with exit 1 before any session-dir side effects (same ordering as `--resume` validation). Claude soft-dropped flags are stripped with a stderr warning; launch continues. The entrypoint does not re-validate — the CLI is the trust boundary, not the image.

### Denylist

Each entry covers all canonical forms (`--flag`, `-f`, `--flag=val`, `-fval`).

#### HARD deny — ccairgap-owned

| Claude flag | ccairgap equivalent |
|-------------|---------------------|
| `-n`, `--name` | `ccairgap --name` (drives session id, container name, branch) |
| `-r`, `--resume` | `ccairgap --resume` (drives transcript copy + name→UUID resolution) |
| `-p`, `--print` | `ccairgap --print` (drives docker `-it` → `-i`, clipboard bridge off) |

#### HARD deny — resume-family

| Claude flag | Why |
|-------------|-----|
| `-c`, `--continue` | "continue most recent in cwd" is meaningless inside a freshly-cloned session workspace |
| `--from-pr` | requires GitHub auth; the container has none |
| `--fork-session` | pairs with `-r` / `-c`, both denied |
| `--session-id` | conflicts with `CCAIRGAP_NAME`-driven id plumbing |

#### HARD deny — broken inside the sandbox

| Claude flag | Why |
|-------------|-----|
| `--ide` | IDE socket not exposed by default; use `--docker-run-arg -v /path/to/ide-socket:...` to wire one up |
| `-w`, `--worktree` | ccairgap IS the isolation layer; use a second `ccairgap` invocation for parallel worktrees |
| `--tmux` | pairs with `--worktree` (also denied); tmux binary not in the image |
| `--add-dir` | host paths do not resolve in the container; use `ccairgap --ro <path>` |
| `--plugin-dir` | host paths do not resolve; plugins flow via host `~/.claude/plugins/` RO mount |
| `--debug-file` | host paths do not resolve; use `--debug` and capture container stderr |
| `--mcp-config` | bypasses ccairgap's MCP allowlist (`--mcp-enable`); also references host paths |
| `--strict-mcp-config` | pairs with `--mcp-config` (also denied) |
| `--settings` | bypasses ccairgap's hook/MCP policy; adjust host `~/.claude/settings.json` or use `--hook-enable` / `--mcp-enable` |

#### HARD deny — pointless inside a fully-wired container

| Claude flag | Why |
|-------------|-----|
| `-h`, `--help` | would exit before the session starts; run `claude --help` on the host |
| `-v`, `--version` | would exit before the session starts; run `ccairgap doctor` for the in-image version |
| `--chrome`, `--no-chrome` | no Chrome binary inside the container; the integration cannot run |
| `--bg`, `--background` | background mode returns at once; the container's main process exits and the container stops. Use `ccairgap --print` or a second `ccairgap` session |
| `--desktop` | no Claude Desktop app inside the container; run `claude --desktop` on the host |

#### SOFT drop (warn on stderr, strip)

| Claude flag | Why |
|-------------|-----|
| `--dangerously-skip-permissions` | already set unconditionally by the entrypoint |
| `--allow-dangerously-skip-permissions` | redundant with the above |

#### Allow (implicit)

Everything not above passes through unchanged. Examples: `--model`, `--effort`, `--agent`, `--agents`, `--permission-mode`, `--append-system-prompt`, `--system-prompt`, `--allowed-tools` / `--allowedTools`, `--disallowed-tools` / `--disallowedTools`, `--tools`, `--fallback-model`, `--verbose`, `--debug`, `--betas`, `--brief`, `--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections`, `--setting-sources`, `--autocompact`, `--permission-prompts`, `--system-prompt-snapshot`, `--plugin-url` (fetches a plugin `.zip` over the network for the session; its hooks and MCP servers are not filtered by `--hook-enable` / `--mcp-enable`), and the cloud/remote flags `--cloud`, `--teleport`, `--environment`, `--remote-control` (they need network access to Anthropic's cloud-session service), plus print-mode companions (`--output-format`, `--input-format`, `--max-budget-usd`, `--json-schema`, `--no-session-persistence`, `--include-partial-messages`, `--include-hook-events`, `--replay-user-messages`) — print-mode companions only meaningfully combine with `ccairgap --print`.

### Tokenization

`src/claudeArgs.ts` walks tokens in flag-position. `--flag=val` splits on the first `=` (lookup target = `--flag`, value preserved if allowed). For short forms, `-x` and `-xval` (inline value) are normalized via the short→long map for `-n`/`-r`/`-p`/`-c`/`-v`/`-h`/`-w`. A small value-taking-flag table (sourced from `claude --help`) tells the walker when to skip the next token as a value rather than re-classify it as a flag — covers both denied (`-n`, `--add-dir`, `--mcp-config`, …) and allowed (`--model`, `--agent`, `--agents`, `--permission-mode`, …) value-takers, so JSON values containing `--` substrings (e.g. `--agents '{"foo": "--not-a-flag"}'`) don't trigger spurious denials.

**Unknown flags default to "no value."** Conservative: false-positives on a denied-adjacent flag error visibly (the user discovers a missing entry in the value-taking table); the alternative would mask denied tokens by treating them as values. `--add-dir` after `--unknown-new-flag` errors on `--add-dir` (correct outcome — extend the value-taking table when a real new value-taking flag lands).

### Forward compatibility

If a future Claude Code flag needs to join the denylist (e.g. a new host-path flag), that is an additive ccairgap change — bump the denylist in `src/claudeArgs.ts` and the table above. Until then, new flags work the day they ship.

## Hook policy

Claude Code hooks run arbitrary host commands in response to tool calls and session events (`PreToolUse`, `PostToolUse`, `SessionStart`, `Notification`, `UserPromptSubmit`, `Stop`, `PermissionRequest`). Host-side hook configs routinely reference binaries (`afplay`, project-local `python3` scripts, user-installed CLIs) that are not present in the sandboxed container; left unfiltered, they fail on every tool call and break the session.

**Default: all hooks disabled, statusLine preserved.** The CLI sets `disableAllHooks: false` and overlays an empty `hooks: {}` field at every hook-bearing source (user settings, every enabled plugin's hook files and manifest, project settings). No hook command is executed. `statusLine` survives — Claude Code's `disableAllHooks: true` flag would also kill the custom status line, so this default explicitly avoids it. Trade-off: any future hook source ccairgap doesn't enumerate would slip through; keep `enumerateHooks`, `applyHookPolicy`, and `applyPluginPolicy` in lockstep.

**Opt-in: `--hook-enable <glob>` (repeatable) or `hooks.enable: [<glob>, …]` in config.** Each glob is matched against the raw `command` string of each hook entry. Wildcard is `*` (anchored full match). Hooks whose command matches any glob are kept; everything else is stripped. Glob semantics are deliberately thin — users see the exact `command` strings in their JSON, so a substring-with-`*` match is sufficient to describe intent.

### Mechanism

Claude Code has **no native per-hook disable**; the only global switches are `disableAllHooks: true` (suppresses every hook **and** the custom `statusLine`) and `enabledPlugins[<key>] = false` (disables an entire plugin, which also loses its skills/commands/agents — too coarse for per-hook opt-in). The `disableAllHooks` flag is unusable as ccairgap's default because it kills `statusLine`, so instead the CLI rewrites hook-bearing JSON host-side at every source and overlays the patched copies in the container via nested single-file bind mounts. The same overlay path runs whether the enable list is empty (filtered = `{}`, neutralizing every hook) or non-empty (filtered down to surviving entries).

- **User settings:** host `~/.claude/settings.json` is read, its `hooks` field is filtered, and `disableAllHooks: false` is forced (overrides any host-level setting and keeps `statusLine` running). The patched file is written to `$SESSION/hook-policy/user-settings.json` and mounted RO at `/host-claude-patched-settings.json`. The entrypoint `cp`s it over the rsync'd `settings.json` before the env-merge step.
- **Plugin hooks:** filtered by `applyPluginPolicy`. See §"Plugin policy".
- **Project settings:** for each repo (`--repo` + every `--extra-repo`), both `.claude/settings.json` and `.claude/settings.local.json` in the session clone are read, filtered, and overlaid via a single-file bind mount at the repo's container path. The session clone on disk is not modified — the overlay leaves `git status` clean. Always runs.

Host files are never mutated; all patched copies live under `$SESSION/hook-policy/` and `$SESSION/plugin-policy/` and die with the session dir.

### Scope and limitations

- **Identification is by `command` string alone.** No type/matcher/event-based targeting. Users who want to enable "all `python3` hooks but only in PreToolUse" should either encode intent in the command (common) or accept that `python3 *` keeps them all.
- **No probing.** The CLI does not introspect the container image to decide which commands would work. Enabling a hook whose command is missing still fails at hook invocation; users who extend the Dockerfile are trusted to match their enable list to their image.
- **Matcher and event structure is preserved.** Only inner hook entries are dropped; matcher groups and event arrays that become empty are then pruned to avoid `hooks: { PreToolUse: [] }` fragments.
- **MCP hook sources** are not a distinct class in Claude Code's config — hooks live in user settings, project settings, or plugin hook files / manifests. Any MCP that registers hooks does so through one of those surfaces, all of which are covered.
- **`statusLine` is not filtered.** The user-settings spread preserves it verbatim; the script runs on every refresh tick if its binary deps exist in the image. Users who don't want the host statusline running inside the sandbox should remove `statusLine` from their host settings (or unset it via a project-level `~/.claude/settings.json` overlay) — `--hook-enable` does not touch it.

### CLI surface

- Flag: `--hook-enable <glob>` — repeatable.
- Config file key: `hooks.enable: [<glob>, …]` (nested map; kebab and camel both accepted at the top level, but `enable` is the only valid sub-key).
- Merge: CLI values append to config values (same semantics as `--ro` / `--extra-repo`).
- Introspection: `ccairgap inspect` prints the full config surface ccairgap would see at launch as JSON `{hooks, mcpServers, env, marketplaces}` (or human-readable tables with `--pretty`):
  - `hooks` — every hook entry across all sources (user settings, enabled plugins, project settings).
  - `mcpServers` — every MCP server definition (user, user-project, project, plugin; with approval state for project-scope).
  - `env` — every `env` var set in user / project / project-local `settings.json`.
  - `marketplaces` — every `extraKnownMarketplaces` entry across the same three scopes, with a `sourceType` shortcut (`github` / `git` / `directory` / `file` / `hostPattern` / `settings`) and a `hostPath` shortcut for `directory` / `file` types.
  Users can build their enable-globs from the exact `command` strings, see which MCPs would load, confirm `env` passthroughs, and know which marketplace source paths will be RO-mounted, without walking plugin caches, project settings, or `~/.claude.json` by hand. Read-only.
  Managed-settings tiers (OS-level policy files, MDM plist/registry, Anthropic-delivered server-managed) are intentionally omitted — they aren't mounted into the container and don't affect what Claude sees inside the sandbox.

## MCP policy

Claude Code MCP (Model Context Protocol) servers are external processes Claude Code starts and speaks to via stdio/SSE/HTTP. Host configs routinely declare servers that the container can't start cleanly — binaries missing from the image, env vars / credentials that aren't passed through, host-only transports. Left unfiltered, each broken server prints errors on startup; more importantly, running a server the user didn't intend in the sandbox is a silent capability expansion.

**Default: all MCP servers disabled.** The CLI overlays `mcpServers: {}` at every MCP-bearing source (user `~/.claude.json` top-level, user-project `~/.claude.json` `projects[*].mcpServers`, project `<repo>/.mcp.json`, enabled plugin `.mcp.json`, `.claude-plugin/plugin.json` `mcpServers`, and each `.json` file that manifest names). No server starts.

**Opt-in: `--mcp-enable <glob>` (repeatable) or `mcp.enable: [<glob>, …]` in config.** Each glob is matched against the MCP server **name** (the key under `mcpServers`). Wildcard is `*` (anchored full match). Names matching any glob are kept; everything else is stripped. Project-scope servers (`<repo>/.mcp.json`) are additionally gated by host approval (see below).

### Why name, not command

MCP servers come in three transports: stdio (`command` + `args`), SSE (`url`), HTTP (`url` + `headers`). Only stdio carries a `command` string. Name is the only stable, user-visible identifier across all transports and appears directly in `ccairgap inspect` output.

### Project-scope trust gate

Claude Code treats `<repo>/.mcp.json` servers as untrusted — a server only runs after the user approves it via the `/mcp` TUI or by adding its name to `enabledMcpjsonServers` / setting `enableAllProjectMcpServers: true` in user, project, or `settings.local.json`. Approval state is persisted across those surfaces plus `~/.claude.json` `projects[<abs-path>]`.

Inside the airgap container the approval dialog is unreachable (non-interactive startup, no user to click). The CLI therefore uses host approval as the trust signal: a project-scope server that matches `--mcp-enable` but was never approved on the host is stripped. Approval must be in place before launch. `disabledMcpjsonServers` wins over both approval and glob — a denied server always gets stripped.

User-scope (`~/.claude.json` top-level), user-project scope (`~/.claude.json` `projects[*].mcpServers`), and plugin-scope servers have no such gate: the user put the server there / enabled the plugin themselves, glob match alone is sufficient.

### Mechanism

Same overlay pattern as §"Hook policy":

- **`~/.claude.json` (user + user-project scope):** host file is read, `mcpServers` (top-level) and every `projects[*].mcpServers` are filtered, the patched copy is written to `$SESSION/mcp-policy/claude-json.json` and mounted RO at `/host-claude-patched-json`. The entrypoint `cp`s it over `~/.claude.json` before the jq onboarding patch. Always produced.
- **Plugin MCP servers:** filtered by `applyPluginPolicy`. See §"Plugin policy".
- **Project `<repo>/.mcp.json`:** for each repo (`--repo` + every `--extra-repo`), if the session clone has `.mcp.json` it is filtered by glob AND approval state, written to `$SESSION/mcp-policy/projects/<repo>/.mcp.json`, and mounted RO at the repo's container path. Approval is derived from the host paths (user settings, `<repo>/.claude/settings.json[.local]`, `~/.claude.json` `projects[<abs>]`) — same scopes as `enumerateMcpServers`, so what `ccairgap inspect` shows as `approved` is exactly what survives the filter.

Host files are never mutated; all patched copies live under `$SESSION/mcp-policy/` and `$SESSION/plugin-policy/` and die with the session dir.

### Scope and limitations

- **Identification is by name alone.** No transport/command-based targeting. A user who wants "only stdio MCPs" should enumerate names, not types.
- **Enabling ≠ working.** The filter decides what makes it past the sandbox. The server still has to start inside the container — its binary must be installed in the image (custom Dockerfile) and any required env vars / credentials must be passed through (`--docker-run-arg "-e NAME"`). A matched but unrunnable server will fail at start-time like it would on the host.
- **MCP server hooks** are declared via the plugin/user/project hook surfaces, not MCP surfaces. Enabling an MCP does not enable hooks it registers — those go through `--hook-enable`.
- **Managed MCP tiers** (`/Library/Application Support/ClaudeCode/managed-mcp.json` and peers) are not mounted into the container. They are also not filtered — Claude Code inside the container won't see them at all.
- **No "enable except X" semantics.** Only additive enable (subject to the project-scope approval AND). If you want most-but-not-one, enumerate the specific names.

### CLI surface

- Flag: `--mcp-enable <glob>` — repeatable.
- Config file key: `mcp.enable: [<glob>, …]` (nested map; kebab and camel both accepted at the top level, but `enable` is the only valid sub-key).
- Merge: CLI values append to config values (same semantics as `hooks.enable` / `--ro` / `--extra-repo`).
- Introspection: `ccairgap inspect` prints every server name and source; see §"Hook policy" CLI surface for the full shape.

## Plugin policy

Plugins carry hook and MCP config in several files. `applyPluginPolicy` (`src/pluginPolicy.ts`) filters all of them in one pass, with the `--hook-enable` globs for hooks and the `--mcp-enable` globs for MCP servers. One function owns every plugin file because one file can carry both kinds of config, and two overlays on one path would collide.

**Plugin roots.** `listEnabledPluginRoots` (`src/pluginRoots.ts`) returns one root per enabled plugin (`enabledPlugins[<plugin>@<market>] === true` in user `settings.json`):

- **Cache-backed:** each `installPath` in `~/.claude/plugins/installed_plugins.json` for that key, when the path resolves inside `~/.claude/plugins/cache/`. Claude Code loads only the recorded version. Older version dirs stay in the cache with an `.orphaned_at` marker until Claude Code removes them, and ccairgap ignores them. When `installed_plugins.json` is missing or unreadable, every version dir of the plugin counts as a root, so the filter fails closed.
- **Directory-sourced:** marketplaces with `source.source === "directory"` in `extraKnownMarketplaces`. Each `plugins[]` entry of the marketplace's `.claude-plugin/marketplace.json` gives one root at its host source dir.

**Files filtered per root.**

| File | Filter |
|------|--------|
| `hooks/hooks.json` | `hooks` filtered by hook globs. Other keys kept. |
| `.mcp.json` | `mcpServers` filtered by MCP globs, or the bare server map when the file has no `mcpServers` key. |
| `.claude-plugin/plugin.json` | Inline `hooks` / `mcpServers` objects filtered. References to `.json` files inside the plugin root are kept, and each named file is filtered like the default file of the same kind. `.mcpb` / `.dxt` bundle entries (paths or URLs) are removed, because their server names cannot be read host-side. Entries that Claude Code would reject (absolute paths, `..` escapes, symlinks that leave the root, missing files) are removed. A scalar field with no surviving entry is deleted. An array field keeps its array shape. Other manifest keys are kept. |

Each patched copy is written to `$SESSION/plugin-policy/<kind>/<market>/<plugin>[/<ver>]/<rel>` and mounted RO at every container path of the root (see §"Container mount manifest"). For cache-backed roots, those paths are the container-`$HOME` cache path and the host-absolute `installPath`. Claude Code reads the plugin at the host-absolute path, so the overlay at that path is the one that takes effect. Mount source kind is `plugin-override`.

**Limitations.**

- `hooks` / `mcpServers` declared in a marketplace entry (`marketplace.json` `plugins[]`, used when the entry sets `strict: false`) are not filtered.
- Plugins loaded with `--plugin-url` are fetched at runtime inside the container and are not filtered.
- An MCP server that ships only as a `.mcpb` / `.dxt` bundle cannot be enabled through `--mcp-enable`.

`ccairgap inspect` enumerates the same roots and files (`enumerateHooks`, `enumerateMcpServers`), so what it lists matches what the filter sees.

## Plugins, skills, commands, CLAUDE.md

**Host config copy-in:**
- Entrypoint `rsync -rL` from `/host-claude` into container `~/.claude/`. `-L` materializes host symlinks as plain files/dirs in container RW.
- Applies to: `settings.json`, `CLAUDE.md`, `statusline.sh`, `plugins/` (minus `cache/`), `skills/`, `commands/`, anything else in `~/.claude/` except session-specific dirs (`projects/`, `sessions/`, `todos/`, `shell-snapshots/`, `history.jsonl`), `plugins/cache/` (RO-mounted separately), and `.credentials.json` (handled via `/host-claude-creds-dir`).

**Project-scope working-tree overlay:**
- After `git clone --shared` + `git checkout -b ccairgap/<id>`, the CLI `rsync -rL`s an allowlist of host-working-tree paths into each session clone (per `--repo` / `--extra-repo`):
  - Under `<hostPath>/.claude/`, each of: `settings.json`, `settings.local.json`, `commands/`, `agents/`, `skills/`, `hooks/` → `<clonePath>/.claude/<name>` (merge; host overwrites clone on conflict)
  - `<hostPath>/.mcp.json` → `<clonePath>/.mcp.json`
  - `<hostPath>/CLAUDE.md` → `<clonePath>/CLAUDE.md`
- Rationale: `git clone --shared` checks out HEAD, so uncommitted / `.gitignore`'d project-scope config is invisible to the container. Notably, `.claude/settings.local.json` is gitignored by Claude Code convention and carries MCP approvals + permission allow-lists; without the overlay every session starts with those reset.
- Allowlist (not whole-`.claude/`) because users sometimes park non-Claude data under `.claude/` (git worktrees, build caches, logs) that can run to multi-GB and stall the overlay. The allowlist mirrors Claude Code's documented project-scope layout — grow it when Claude Code ships a new project-scope subpath.
- Symlink handling: `rsync -L` follows symlinks and materializes targets as real files. Handles the common `CLAUDE.md → AGENTS.md` swap and out-of-repo skill targets uniformly — the container only ever sees real files.
- Scope is closed and minimal: only the paths above. Other repo-root paths (e.g. `.env.local`, generated configs) and non-listed `.claude/*` entries are out of scope — use `--cp` / `--sync` as today.
- Interaction with `dirtyTree`: `.claude/`, `.mcp.json`, `CLAUDE.md` are excluded from the exit-time scan via pathspec (`:(exclude).claude :(exclude).mcp.json :(exclude)CLAUDE.md`). The `.claude` exclude is deliberately a superset of the overlay allowlist so overlay-introduced "uncommitted" state never triggers preservation **and** container-side writes to non-overlaid `.claude/*` paths (e.g. plugin-install flows) are also silently discarded on exit (by design — sandbox shouldn't mutate Claude config across sessions).
- Ordering: overlay runs AFTER `writeAlternates`, BEFORE `applyHookPolicy` / `applyMcpPolicy` / `executeCopies`. Hook + MCP policy filters then see host working-tree content. Explicit `--cp` / `--sync` still wins (runs last).

**Plugin marketplace discovery:**
- The CLI extracts absolute paths from `extraKnownMarketplaces` entries in host `~/.claude/settings.json` whose `source.source` is `"directory"` or `"file"`. These reference plugin marketplaces living outside `~/.claude/` (e.g. `~/src/agentfiles`, `~/src/claude-meta`).
- `github`/`git`/`npm`/`url` marketplaces resolve via `known_marketplaces.json` whose `installLocation` points at `~/.claude/plugins/marketplaces/<name>`, and `installed_plugins.json` whose `installPath` points at `~/.claude/plugins/cache/<market>/<plugin>/<ver>`. Both fields store absolute host paths, so ccairgap RO-mounts `~/.claude/plugins/` at its host absolute path (in addition to the container-$HOME cache mount). No extra per-marketplace mount needed.
- Each extracted path is RO bind-mounted at its original absolute path so `settings.json` references resolve inside the container — UNLESS the path equals or is nested inside a `--repo`/`--extra-repo` tree, in which case the mount is dropped (the repo's session clone already serves those files at the same container path). A stderr warning names the affected marketplace.

Exact jq query:
```bash
jq -r '
  .extraKnownMarketplaces // {}
  | to_entries[]
  | select(.value.source.source == "directory" or .value.source.source == "file")
  | .value.source.path
' "$HOME/.claude/settings.json"
```

Post-processing in the CLI:
1. For each path: `readlink -f` to resolve symlink chains.
2. Deduplicate.
3. Skip any path already under `$HOME/.claude/` (already covered by the main RO mount).
4. For each remaining path, append `-v <resolved>:<original>:ro` to the docker run command.

**Symlink handling:**
- `readlink -f` applied to every host path before mounting so symlink chains resolve to real files.
- Entrypoint's `rsync -L` handles any remaining symlinks inside the copied tree (transformed into their target files).

**Update suppression:**
- Env vars in settings.json `env` block disable Claude Code auto-update, feedback, telemetry, error reporting, and the official marketplace first-run autoinstall.
- Plugin installs during a session are blocked by the RO `plugins/cache/` mount — any `/plugin install` attempt fails when it tries to write the cache. No separate marketplace allowlist needed.

**MCP servers:**
- `~/.claude.json` `mcpServers` block (user scope) and `projects["<path>"].mcpServers` (local/user-project scope) are copied as-is into the container via the `/host-claude-json` mount + entrypoint `cp`. Project-scope `<repo>/.mcp.json` travels in with the session clone. Plugin-scope MCPs (`<plugin>/.mcp.json`, `<plugin>/plugin.json#mcpServers`) travel via the RO plugin-cache mount for cache-backed plugins, or via the marketplace-source-tree RO mount (from `discoverLocalMarketplaces`) for directory-sourced marketplace plugins.
- MCPs requiring binaries not present in container (e.g. `docker` for the grafana MCP) fail silently at startup.
- Users who want specific MCPs to work extend the Dockerfile with their own `RUN apt-get install ...` or equivalent.
- `ccairgap inspect` enumerates every surface above (plus approval state for project-scope servers) so users can tell at a glance which MCPs will actually load.

**Plugin install during session:**
- `~/.claude/plugins/cache/` is RO-mounted.
- `/plugin install`, `/plugin marketplace update`, etc. error out because they can't write to cache.
- Intentional: no session-local plugin install. If a plugin is needed, it belongs in the Dockerfile.

## Run mode

Entrypoint dispatches through `CCAIRGAP_ENTRYPOINT_MODE`: missing or `agent` launches the selected agent, and `exec` runs the exact command argv supplied after `ccairgap exec --`. The entrypoint checks `CCAIRGAP_TEST_CMD` before production branch selection; if set, it `exec sh -c "$CCAIRGAP_TEST_CMD"` instead. This is a test-only hook; the CLI never sets it.

- `ccairgap` drops directly into Claude's REPL.
- `ccairgap exec -- aharness recipe-driven-design.fsm.ts` prepares the sandbox and runs that exact argv.
- For walk-away use, user wraps in tmux on the host: `tmux new -s work 'ccairgap ...'`.
- No in-container tmux; the Dockerfile does not install it.

## Network

- Without a `network` config key: default Docker bridge network and full outbound.
- With a `network` config key: `--network none` on the agent container and a proxy sidecar. See §"Network policy".
- Capabilities: `--cap-drop=ALL` (no Linux capabilities granted). Container runs as a non-root user, needs no capabilities for normal Claude / git / node operation. Prevents raw sockets, ARP spoofing, firewall manipulation, chown, and everything else. It does not block HTTP/HTTPS exfiltration.
- `--security-opt=no-new-privileges`: blocks setuid/setgid binaries and file capabilities from granting additional privileges inside the container. Defense-in-depth against a local-priv-esc primitive chained with any cap regression.

## Network policy

The `network` config key limits the outbound traffic of one session. The key is opt-in. A session without the key keeps full outbound. User-facing guide: `docs/network.md`.

### Enforcement

The agent container runs with `--network none`, so its only interface is `lo`. The kernel enforces this limit, and code in the agent container cannot change it, because the container has no capabilities. The agent reaches the network only through a proxy in a separate container, which holds the policy.

```
agent container (--network none)            sidecar container (bridge network)
  client -> 127.0.0.1:3128 -> forwarder  ->  /run/ccairgap-network/sock/proxy.sock
                                               -> relay -> mitmproxy 127.0.0.1:8080 -> internet
```

- The forwarder (`docker/network/forwarder.mjs`) is a Node script that the agent container runs from the entrypoint. It copies bytes from `127.0.0.1:3128` to the socket. It enforces nothing, and an agent that kills it loses all network access.
- The relay (`docker/network/relay.py`) copies bytes from the socket to mitmproxy.
- The sidecar runs `mitmproxy/mitmproxy` pinned by tag and digest in `src/network.ts`. No flag or env var changes this image.
- Sidecar hardening: `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--read-only`, non-root user, `--tmpfs /tmp`, and a tmpfs for the CA. The sidecar has no bind mount from the agent container and no writable bind mount from the host.
- Each session generates its own CA in the sidecar tmpfs. The CA private key stays in the sidecar. The CLI copies the CA certificate to `$SESSION/network/agent/ca.pem`.

The Linux kernel enforces `--network none` on the Linux VM or host that runs Docker, so the mechanism is the same on Docker Desktop, OrbStack and native Linux. Tests ran on OrbStack and on dockerd 29.9.3 in Docker-in-Docker. Docker Desktop is untested.

### Config

```yaml
network:
  agent-preset: true        # default true. Adds the rules that the selected agent needs.
  check-credentials: true   # default true. See "Credential check".
  rules:                    # default []. First match wins. No match denies the request.
    - action: allow         # allow | deny. Default allow.
      host: github.com      # exact name or "*.example.com". Bare "*" and "*.com" are rejected.
      ports: [443]          # default [443] on allow, every port on deny
      methods: [GET, POST]  # default all methods
      paths: ["/acme/*"]    # default all paths. Must start with "/". "*" matches any characters.
```

- Presence of the key activates the policy. `network: {}` allows the agent preset only. `agent-preset: false` with no rules denies every request.
- The key is valid in project config and profiles. A `network` key in the user-wide `config.yaml` or an integration drop-in is a hard error, because the policy belongs to the repository or profile.
- There is no CLI flag and no env var for the policy. `--config` and `--profile` select the file that holds it.
- Config discovery uses the git repository that contains the current directory, and `--repo` does not change it. A launch from outside the repository does not load that repository's policy. `--bare` without `--config` or `--profile` loads no policy. The launch banner shows whether a policy is active.
- Scalar merge: a later layer replaces the whole key.
- The CLI validates every rule before any side effect and prints the active rules to stderr at launch.
- `*.example.com` matches `a.example.com` and `a.b.example.com`. It does not match `example.com`.
- A rule with `paths` matches the path without the query string. The query is not matched.
- An allow rule with `paths` matches one exact spelling, case-sensitively. A deny rule also matches the spelling with `%2F` decoded, `;` parameters and trailing slashes removed, repeated slashes collapsed, and case folded, because a server can route those variants to the denied resource. A server with other routing rules can still receive a variant that no deny rule matches. Prefer allow rules.

### Agent presets

User rules run first and the preset runs after them, so a user deny rule can narrow a preset host. `exec` uses the preset of `--agent`.

| Agent and auth | Host | Methods | Paths |
|---|---|---|---|
| Claude | `api.anthropic.com` | `GET`, `POST` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/mcp_servers`, `/api/web/domain_info` |
| Codex with ChatGPT auth | `chatgpt.com` | `GET` | `/backend-api/codex/responses` (WebSocket), `/backend-api/codex/models`, `/backend-api/wham/accounts/check` |
| Codex with an API key | `api.openai.com` | `GET`, `POST` | `/v1/responses` |

Claude Code tolerates a denied `mcp-proxy.anthropic.com` and retries. Codex exits when `/backend-api/wham/accounts/check` is denied. ccairgap measured the Claude and Codex ChatGPT presets with real sessions. `POST /v1/messages/count_tokens` and the Codex API-key preset have no successful measurement.

### Request decision

The addon (`docker/network/policy.py`) evaluates requests in this order. A request denied at steps 1 to 5 gets `403`, and the proxy opens no upstream connection for it. A connection denied at step 6 gets `502`. A hook that raises an exception denies, because mitmproxy otherwise lets the flow continue.

1. `http_connect`: the proxy denies a `CONNECT` when no allow rule can match the host and port.
2. Consistency: the proxy denies a request when the `Host` header, the absolute-form authority or the TLS SNI differs from the target host, or when the version is anything other than `HTTP/1.0` or `HTTP/1.1`. In a tunnel, the target is the host of the `CONNECT`. mitmproxy reads the `Host` header only for HTTP/1 and the authority only for HTTP/2, and it sends both upstream, so each name needs its own check.
   The proxy also denies a header with a bare CR, LF or NUL, an invalid header name, a routing header (`X-HTTP-Method-Override`, `X-HTTP-Method`, `X-Method-Override`, `X-Original-URL`, `X-Rewrite-URL`, `X-Forwarded-Host`, `X-Forwarded-Server`, `X-Original-Host`, `X-Host`, `Forwarded`, with `_` read as `-`), a method that is not uppercase, and a body on `GET` or `HEAD`.
3. Path normalization: the proxy percent-decodes the path until it is stable. It denies a path over 8 KiB, invalid UTF-8, `%uXXXX`, `#`, a segment of only dots and spaces after NFKC normalization, an empty segment other than a trailing slash, a backslash or a control character. Rules match the decoded path, except that an encoded slash stays `%2F`, because a server normally routes it as one segment. The dot-segment check treats `%2F` as a separator.
4. Rules: the first rule whose host, port, method and path all match decides. No match denies the request.
5. Credential check: see below.
6. Address check: the addon wraps the event loop's `getaddrinfo`, so the lookup that opens the connection denies the connection if any address is not public. asyncio connects to the results of that one lookup, so DNS rebinding has no second lookup to use. A `server_connect` hook checks IP literals, which asyncio connects to with no lookup. The check reads the IPv4 address inside mapped, IPv4-compatible, SIIT, NAT64 and 6to4 forms, and it also denies addresses that `ipaddress` reports as global but are not public destinations, such as the Azure wire server. A hostname that the rules deny never reaches the resolver, because the proxy connects lazily. The address stays a hostname, because mitmproxy reuses an upstream connection only when the addresses match, and a request after the fifth in a tunnel otherwise stalls.

Other protocols: the proxy kills raw TCP streams (`rawtcp=false` and a `tcp_start` hook) and refuses HTTP/3. SSH to a git remote therefore fails. HTTP/2 from the client is off, so the addon sees one request per stream in HTTP/1.1. mitmproxy closes the connection when a client half-closes its side, so such a client gets no response.

The addon logs one JSON object per decision to the sidecar stdout: stage, verdict, reason, method, host, port and path. The log never contains header values, query strings or bodies, and it holds at most 512 characters of a path. Each denial carries a sequence number, so at exit the CLI summary can state how many denials log rotation removed. An agent can still push real denials out of the 20 lines that the summary shows.

Body limits: mitmproxy reads a whole request body before it sends a response that a hook set, so the addon kills a denied request that declares more than 1 MiB or uses chunked encoding. The client sees the connection close with no `403`. The addon removes each WebSocket message from the flow after relay, because mitmproxy otherwise keeps every message. `--memory=1g` bounds the sidecar. The agent has no route if the kernel kills the sidecar at this limit.

### Credential check

The check stops an agent from sending data to another account through an allowed provider API. For `api.anthropic.com`, `chatgpt.com` and `api.openai.com`, the proxy compares the SHA-256 of the `Authorization` bearer token and `x-api-key`, with `_` in a header name read as `-`, against an allow set. Any other authorization scheme never matches. A mismatch denies the request. A request without a token passes, and the proxy removes its `Cookie` header, so the server treats it as unauthenticated. The check applies to these hosts with or without the preset. A session has hashes only for the host of its own agent, so a token for another provider needs `check-credentials: false`.

- The CLI writes the allow set to `$SESSION/network/sidecar/credentials/<host>` on the host. The sidecar mounts it read-only and the agent does not mount it.
- The set holds hashes of the tokens that the CLI wrote to session credentials, and of the host env var `CODEX_API_KEY` in Codex print mode. The agent has RW on `$SESSION/creds`, so the CLI never reads tokens back from that file after launch. The runtime auth-refresh watcher adds a hash before each host-driven write, and hashes accumulate for the session. If the hash write fails, the watcher skips the session write and tries both at the next tick, because the proxy would deny the new token.
- Consequences: in-container `/login` does not work under a policy with `check-credentials: true`, because the new token has no hash. For Claude, a host login reaches the session through the watcher within 60 seconds, unless an in-container `/login` already wrote a refresh token, which stops the watcher. Codex has no runtime refresh, so an expired Codex token needs a new session. A `-e ANTHROPIC_API_KEY` passed through `--docker-run-arg` also has no hash and needs `check-credentials: false`.

### Limits

The policy does not inspect request bodies or WebSocket frames.

- **Data in allowed requests.** An agent can place any data in a request to an allowed host. This includes the Messages API body and the Codex WebSocket frames.
- **Server-side fetches.** Anthropic documents `mcp_servers`, URL image sources and URL document sources in the Messages API. Those features can cause a provider to contact a third party with data from the request body. `GET /api/web/domain_info` in the Claude preset takes a domain name in its query, and it may cause a provider lookup of that name. The policy does not block them. The proxy sees only the request to the provider.
- **Any allowed host with write access.** `POST github.com` to an account that the agent controls is exfiltration. The credential check covers only the three provider hosts.
- **DNS under a wildcard.** The proxy resolves any host that a rule allows, so a wildcard rule lets an agent place data in a subdomain. A canary resolver saw no query for a denied name and saw queries for an allowed name.
- **Query strings.** Rules do not match the query, so `?_method=DELETE` and data in a query pass any rule that allows the path.
- **Mounted host sockets.** A Unix socket reachable through a mount is a route out of the container that the proxy does not see. The CLI rejects a `--ro`, `--mount` or raw mount source that contains a known Docker socket. It cannot find other sockets. On macOS, a host socket file is visible in a mount and refuses connections.
- **Clients and protocols that fail by design.** Non-HTTP protocols fail. A client that pins certificates fails, because it rejects the session CA. A client that ignores the proxy env vars or the CA bundle env vars fails. Private addresses fail, including `localhost` on the host and `host.docker.internal`. Upstream TLS interception fails, because the sidecar verifies upstream servers with public CAs only.
- **Container escape** stays out of scope. An escape reaches whatever the Docker host can reach.

### Agent container environment

The CLI sets these variables when a policy is active:

| Env var | Value |
|---|---|
| `CCAIRGAP_NETWORK_POLICY` | `1`. Tells the entrypoint to start the forwarder. |
| `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy`, `http_proxy` | `http://127.0.0.1:3128` |
| `NO_PROXY`, `no_proxy` | `localhost,127.0.0.1` |
| `NODE_USE_ENV_PROXY` | `1` |
| `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `REQUESTS_CA_BUNDLE`, `PIP_CERT`, `NPM_CONFIG_CAFILE`, `CODEX_CA_CERTIFICATE` | `/home/claude/.ccairgap-network-ca-bundle.pem` |

The entrypoint builds that bundle from `/etc/ssl/certs/ca-certificates.crt` and `/run/ccairgap-network/agent/ca.pem` and starts the forwarder before `CCAIRGAP_TEST_CMD` and mode selection, so agent, exec and test modes all get it. The entrypoint exits non-zero when the forwarder does not listen. `ccairgap attach` inherits the variables through `docker exec`. A host `NODE_EXTRA_CA_CERTS` is not forwarded under a policy, and the CLI prints a warning, because the sidecar verifies upstream servers with public CAs only.

### Conflicting docker args

The CLI rejects these `--docker-run-arg` tokens before any side effect when a policy is active, because each one can bypass the proxy or weaken the sidecar boundary: `--network`, `--net`, `--link`, `--network-alias`, `--net-alias`, `--ip`, `--ip6`, `-p`, `--publish`, `-P`, `--publish-all`, `--privileged`, `--cap-add`, `--pid`, `--ipc`, `--uts`, `--userns`, `--cgroupns`, `--runtime`, `--device`, `--security-opt`, `--volumes-from`, clusters of boolean short flags that include `-p` or `-P`, and any token that contains `docker.sock` or matches `ccairgap-network` or `ccairgap-<id>-network`. Values of `-e`, `--env`, `--label` and `-l` are exempt, unless the value starts with `-`, because a value-taking flag before them can make docker read that token as a flag. A `-v`, `--volume` or `--mount` source is also rejected when it contains a known Docker socket, or when it contains or lies inside the ccairgap state root. The `--ro` and `--mount` flags get the same checks, except that `--ro` over the state root stays allowed, because a read-only view cannot change the policy. A known socket is `/var/run/docker.sock`, `/run/docker.sock`, or an existing `~/.docker/run/docker.sock`, `~/.docker/desktop/docker.sock`, `$XDG_RUNTIME_DIR/docker.sock` or `DOCKER_HOST` unix path. This is a hard error. Without a policy, only the tokens in §"Raw docker run args" produce a warning, and the rest produce nothing. The scan covers known flags and is not a proof of completeness. `--add-host` and `--dns*` stay allowed: they change name resolution only.

### Lifecycle

1. Validation phase: parse rules, select the preset, scan docker args.
2. Just before `docker run`: pull the image when it is missing, create the volume, set its owner, start the sidecar, wait for the socket and the CA, and copy the CA certificate out. A failure removes the sidecar, the volume and the session dir, then aborts.
3. During the session: the CLI watches the sidecar. The relay is PID 1 and supervises mitmproxy, so the sidecar stops when either one stops. When the sidecar exits, the CLI prints a warning. The agent then loses network access, because no fallback route exists.
4. In the exit `finally`: the CLI prints the denial summary, removes the sidecar and removes the volume.
5. A first SIGINT, SIGTERM or SIGHUP to the CLI stops the agent and reaches the same `finally` (see §"Exit trap"). A second signal removes the sidecar without the denial summary and leaves the session on disk. After a SIGKILL, the sidecar stays too. `recover` and `discard` remove a leftover sidecar and volume. If a stopped agent container still holds the volume, they print the removal command.
6. `--keep-container` keeps the stopped agent container, which holds the volume, so volume removal fails. The CLI prints a hint.

## Environment variables

**Inside the container** — set via `~/.claude/settings.json` `env` block:

- `DISABLE_AUTOUPDATER=1`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
- `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`

Also injected at the top level of the same file: `skipDangerousModePermissionPrompt: true` — suppresses Claude Code's one-time "Bypass Permissions mode" startup warning. Container is already sandboxed, so the prompt is redundant and would block non-interactive `-p` runs. Host settings unaffected (container settings.json is rsync'd from host then patched in-place; writes never leak back).

`disableAgentView: true` is injected in the same file. It turns off `claude agents`, `claude --bg`, `/background` and the on-demand supervisor. These features do not fit the container lifecycle: all background sessions stop when PID 1 exits, and `/bg` ends the container. ccairgap does not support these features. The value overrides a host `~/.claude/settings.json` value. `"disableAgentView": false` in a `.ccairgap/settings.json` or `~/.config/ccairgap/settings.json` overlay turns them on at the user's own risk, because the overlay step runs later and overlay scalars win. The setting is a default that an agent can change inside its container, so it does not enforce anything. Background Bash commands and background subagents inside one session stay on.

These persist across `/clear` and any session restart inside the container.

No `CLAUDE_CODE_OAUTH_TOKEN` env var is used; auth comes from the host's `~/.claude/.credentials.json` via the RO mount.

**Passed from host to container** — set by the CLI on `docker run`:

| Env var | Source | Purpose |
|---------|--------|---------|
| `CCAIRGAP_CWD` | `--repo[0]` (or `/workspace`) | Container cwd for `cd` in entrypoint. |
| `CCAIRGAP_TRUSTED_CWDS` | All repo paths | Trust-dialog bypass in `.claude.json`. |
| `CCAIRGAP_ENTRYPOINT_MODE` | Launch mode | `agent` for selected-agent launch, `exec` for exact command argv mode. Missing defaults to `agent`. |
| `CCAIRGAP_PRINT` | `--print` | Non-interactive prompt. |
| `CCAIRGAP_NAME` | session id | Always set. Carries `<prefix>-<4hex>` from the CLI. Entrypoint uses it for `-n "ccairgap $CCAIRGAP_NAME"` (label) and the UserPromptSubmit rename hook emits `[ccairgap] $CCAIRGAP_NAME`. Resume flows use the same slug — the prior session's display name is not preserved. |
| `CCAIRGAP_RESUME` | `--resume <uuid>` | Set when `--resume` is passed. Entrypoint appends `-r "$CCAIRGAP_RESUME"` to the claude exec. |
| `CCAIRGAP_GIT_USER_NAME` | `git config --get user.name` (run in `--repo[0]`) | Set as `git config --global user.name` in entrypoint. Fallback `ccairgap` if host has none. |
| `CCAIRGAP_GIT_USER_EMAIL` | `git config --get user.email` (run in `--repo[0]`) | Set as `git config --global user.email` in entrypoint. Fallback `noreply@ccairgap.local` if host has none. |
| `COLORTERM` | hardcoded `truecolor` | Enables 24-bit color output in the container terminal. |
| `TZ` | `Intl.DateTimeFormat().resolvedOptions().timeZone` (host IANA zone) | Container timezone matches the host. Resolved via the image's `tzdata` package. Omitted if the host runtime has no IANA zone. |
| `CCAIRGAP_CLIPBOARD_MODE` | `host-bridge` | Set when clipboard passthrough is active. Triggers entrypoint shim install + xclip-regression warning. |
| `CCAIRGAP_NETWORK_POLICY` and proxy variables | `network` config key | Set when a network policy is active. See §"Network policy". |

**On the host** — read by the CLI:

| Env var | Effect |
|---------|--------|
| `CCAIRGAP_HOME` | Overrides the state dir. Default: `$XDG_STATE_HOME/ccairgap/` (which itself defaults to `~/.local/state/ccairgap/`). If set, this path replaces the default root wholesale — both `sessions/` and `output/` live underneath. |
| `CCAIRGAP_CC_VERSION` | Short-form override for `--docker-build-arg CLAUDE_CODE_VERSION=<value>`. Omit it to follow host `claude --version` automatically. |

Other XDG env vars (`XDG_STATE_HOME`, etc.) are respected per the XDG Base Directory spec.

## Handoff routine

Used by both the exit trap and `ccairgap recover`. Takes a `$SESSION/<id>/` dir as input. Must be idempotent — safe to run multiple times on the same dir.

1. Read `$SESSION/<id>/manifest.json`. Check the top-level `"version"` field; if it is unknown to the current CLI, abort with a clear message (`"manifest v<N> requires ccairgap ≥ <X.Y.Z>"`). Otherwise extract the repo→host-path mapping.
2. For each entry in the manifest:
   - **Sanitize the session clone before any other host `git` command.** The container wrote the clone's `.git`, and `git(1)` §SECURITY says that running Git commands in an untrusted `.git` can run arbitrary commands, through config, hooks and pointer files. Handoff follows the documented answer and reads that `.git` only through `upload-pack`. See §"Session clone sanitization".
   - Prepare linked worktrees. Read each `.git/worktrees/<name>/` admin dir that sanitization rebuilt. Map the recorded path to the session clone: a worktree under `<real-host-path>` maps to the same relative path under the session clone. Rewrite the worktree's `.git` file and the admin dir's `gitdir` file to those host paths, so host `git` reaches the session clone and never the real repo's admin dir with the same name. The worktree's contents are untrusted: a symlink there, or a target outside the session clone, counts as a scan failure and no file is written. A worktree recorded outside the session clone is lost with the container, so handoff warns and scans only its branch.
   - For each linked worktree that is checked out on a branch other than the sandbox branch: validate the name with `git check-ref-format`, then count commits not reachable from `origin/*` or the sandbox branch. If the count is > 0, run `git -C <real-host-path> fetch <session-clone> refs/heads/<branch>:refs/heads/ccairgap/<id>-worktrees/<branch>`. This runs whether or not the sandbox branch has commits. The commits on a detached HEAD are not delivered.
   - Count commits on `ccairgap/<id>` not reachable from any `origin/*` ref in the session clone: `git -C <session-clone> rev-list --count ccairgap/<id> --not --remotes=origin`.
     - If the count is 0, **skip the fetch** — the sandbox branch has no new work, and creating an empty ref on the host would be noise. Record the repo as `empty`.
     - If the count is > 0, run `git -C <real-host-path> fetch $SESSION/<id>/repos/<alternates_name> ccairgap/<id>:ccairgap/<id>` (where `<alternates_name>` is the manifest field — falling back to `<basename>` for manifests written by older CLI builds). `git fetch` with an explicit ref is idempotent — running it a second time with the branch already present is a no-op.
   - If fetch fails (branch doesn't exist, host path gone), log and continue — not fatal.
3. For each entry in the manifest's `sync` list (absent in old manifests — treat as empty): rsync `session_src/` → `$CCAIRGAP_HOME/output/<id>/<src_host>/`. `rsync -a` for directories, `cp -a` for files. Missing `session_src` logs and continues — not fatal. Idempotent (safe to re-run).
4. For each `<path-encoded-cwd>` dir in `$SESSION/<id>/transcripts/`:
   - Recursively copy its contents into `~/.claude/projects/<same-dir-name>/` on host (`cp -r` or `rsync -a`, merging with any existing content — session UUIDs make nested dirs unique).
   - This preserves the `<session-uuid>/*.jsonl` and `<session-uuid>/subagents/*.jsonl` structure.
   - Create target dir if missing.
5. If `$SESSION/<id>/codex-sessions/` exists, preflight the full Codex rollout tree, then copy only validated `YYYY/MM/DD/rollout-*.jsonl` regular files to `<manifest.codex.host_home>/sessions/YYYY/MM/DD/`. `manifest.codex.host_home` is authoritative; handoff and `recover` must not rediscover `$CODEX_HOME`. Existing hash-identical rollout files are success. Changed collisions, invalid trees, unsafe destination parents, protected-path overlap, or copy scan failures preserve the session.

   The only Codex host-write path during handoff is `<manifest.codex.host_home>/sessions/`. Handoff must never copy back `$CODEX_HOME/auth.json`, SQLite state, logs, history, memories, themes, plugin data, marketplace data, or any other Codex home contents.
6. **Preserve session dir** (skip step 7) if **any** of the following holds for **any** repo in the manifest, or if Codex rollout copy-out reported a preservation condition:
   - The session clone's working tree is dirty (`git status --porcelain` non-empty, `.gitignore` respected, plus pathspec excludes `:(exclude).claude :(exclude).mcp.json :(exclude)CLAUDE.md` — see §"Project-scope working-tree overlay"). The scan runs after step 2's alternates rewrite — ordering must be preserved. When the caller passes `--no-preserve-dirty` / config `no-preserve-dirty: true`, the scan still runs but a dirty result no longer triggers preservation (the scan stays on so scan-failure can still fire, see next bullet).
   - The dirty-tree scan failed (uncertainty → err on preserve). Fires regardless of `--no-preserve-dirty`.
   - A linked worktree inside the session clone is dirty. The scan and the pathspec excludes are the same as for the session clone, and `--no-preserve-dirty` suppresses this trigger in the same way. `.claude/` stays excluded from the session clone scan, so each worktree under `.claude/worktrees/` needs this separate scan.
   - Linked worktree preparation failed, a worktree scan failed, or a worktree branch could not be validated, counted or fetched. Fires regardless of `--no-preserve-dirty`.
   - The sandbox branch is empty **and** another local branch carries commits not reachable from `origin/*`. A worktree branch that handoff delivered does not count. Fires regardless of `--no-preserve-dirty`. `recover` does not deliver these branches, so the warning prints the manual `git fetch` command and points at `ccairgap discard <id>` for the end of the rescue.

   The warning emitted names every preservation trigger (dirty repos with their modified/untracked counts, scan-failed repos with their git error, orphan branches with their commit counts) and tells the user the exact `cd` path and `ccairgap recover <id>` next step. `ccairgap discard <id>` is offered as an exit only when safe — suppressed when orphan-branch commits would be lost.

   Known limitation: edits to files matched by `.gitignore` (e.g. `.env.local`) are not detected and are lost on exit. Workaround: launch with `--sync <path>`.
7. `rm -rf $SESSION/<id>` unless step 6 preserved it.

### Session clone sanitization

`sanitizeSessionClone` in `src/sessionCloneTrust.ts` runs once per clone, on the host, after the container has stopped. All its state is under `$SESSION/sanitized-git/<alternates_name>/`, which the container cannot see.

1. Reject a `.git` that is not a real directory, a `commondir` file, and a symlink at `objects` or `objects/info`. A rejection counts as a scan failure, and handoff runs no other `git` command for that repo.
2. Move `.git` to `untrusted-git/`, and replace its `objects/info/alternates` with `<real-host-path>/.git/objects/`. No git command may run in `untrusted-git/`. It stays until the session dir is removed.
3. Create a new `.git` with `git init --bare --template=`, so it has no hooks. Set its alternates to the host objects, and set only `core.bare`, `core.logAllRefUpdates` and `remote.origin.*` in its config.
4. Run `git fetch --no-tags --no-recurse-submodules --update-shallow --update-head-ok <untrusted-git> +refs/*:refs/*` in the new `.git`. The clone's `upload-pack` is the only git process that opens the untrusted directory.
5. Copy the `HEAD` text after validation, and build the index with `git read-tree HEAD`. Rebuild each linked worktree's admin dir in the same way.
6. Move the new `.git` into the clone.
7. Walk the working tree without following symlinks, and clear every other `.git`, in any letter case. A regular `.git` file at a path that a rebuilt worktree admin dir names stays, and the host writes its `gitdir:` line. Any other `.git` moves to `nested-git/<hash>`, and a `.ccairgap-moved-git` note takes its place. The note names the new path and keeps a directory that held only a `.git` visible to the dirty scan. An unreadable directory fails the walk, and the failure counts as a scan failure.
8. Write the `done` marker.

Step 7 is required because plain `git status` and `git add -A` in the clone run the config of a repo at a gitlink path, and `git add -A` records an untracked nested repo as a gitlink. A new `.git` at the clone root does not stop either route.

The result is that every later host `git` command in the clone is safe, including the commands that the preservation warning prints for the user. A command run from inside `nested-git/` or `untrusted-git/` is not safe. Reflogs, stash history below the top entry, staged-versus-unstaged differences, and merge or rebase state do not survive the rebuild. `git status` reports all uncommitted changes as working tree changes. Nested repos lose their `.git` in the clone, so `git add -A` records their files as ordinary files, and it also records the note. A `--sync` copy of a path inside the clone runs after this walk, so the copy has the note and no nested `.git`.

`scanOrphans` runs from `list`, from shell completion and at every launch, so a session could still be starting when it runs. It therefore never sanitizes. It runs host `git` only in a clone with the `done` marker, and `list` shows other clones as `not-scanned`.

The dirty scan passes `--ignore-submodules=dirty`, so it never starts a process inside a submodule. Step 7 also removes the submodule's `.git`, so Git cannot see inside a submodule. A populated gitlink directory therefore counts as one modified entry, and a session with an initialized submodule is always preserved unless `--no-preserve-dirty` applies.

Fetches into a real host repo pass `--no-tags`, because tag following would write refs outside §"Host writable paths", and `--no-recurse-submodules`.

Failure at any step does not cause the routine to skip subsequent steps. Goal is best-effort preservation of work.

## Exit trap

On container exit (any reason — normal, error, signal), the CLI runs the handoff routine against the current session's `$SESSION/<id>/`.

A SIGINT, SIGTERM or SIGHUP to the CLI while `docker run` is active ends the session the same way. The CLI runs `docker stop ccairgap-<id>`, retrying until it succeeds or `docker run` has returned, because `docker run` forwards no signal in TTY mode. Handoff starts only after the container stops. The CLI then re-raises the signal, so a parent sees a death by that signal. A second signal runs `docker kill`, removes a network sidecar, and exits without handoff. The session stays on disk for `recover`. A signal earlier in the launch, before `docker run`, has no handler and also leaves the session on disk.

Exit trap is **not** guaranteed to fire. If `ccairgap` itself is SIGKILLed (OOM, `kill -9`, tmux pane force-close, laptop crash, host reboot), the session dir is left intact on disk and no handoff happens. Use `ccairgap recover <id>` to finish it manually.

## Recovery

`ccairgap list` — list orphaned sessions:
- Scan `$XDG_STATE_HOME/ccairgap/sessions/` (or `$CCAIRGAP_HOME/sessions/` if overridden).
- For each entry: if a container named `ccairgap-<id>` is currently running (`docker ps`), skip (live session in another terminal). Otherwise classify as orphan.
- Print timestamp, repos involved (from manifest), and commit counts on `ccairgap/<id>` in each session clone.

`ccairgap recover [<id>]` — with `<id>`, run the handoff routine against `$SESSION/<id>/` (idempotent; safe to re-run). Without `<id>`, equivalent to `list`.

If the session contains a dirty working tree or orphan-branch commits, `recover` does not delete the session dir — it re-emits the same preservation warning. Commit or discard the work in the session clone or linked worktree (paths printed in the warning), then re-run `ccairgap recover <id>` to finalize. `recover` delivers a commit made in a linked worktree as `ccairgap/<id>-worktrees/<branch>`.

`recover <id>` refuses to run against a session whose container is still running (checked via `docker ps --filter name=^/ccairgap-<id>$`). Stop the container with `docker stop ccairgap-<id>` first, or let it exit normally — the exit trap will run handoff.

`ccairgap discard <id>` — `rm -rf $SESSION/<id>/` without running handoff. Use when you don't want the sandbox branch in your real repo.

On every normal `ccairgap` startup, orphaned sessions are detected and a warning banner is printed with the suggested `recover` / `discard` commands. They are not auto-recovered.

## Attach

Advanced subcommand. Runs a second interactive selected agent inside an already-running session container. Intended for power users who understand the implications below; not meant to be ergonomic for casual use.

```
ccairgap attach [--agent claude|codex] <id> -- <selected-agent-args>
```

By default, attach uses the agent recorded in `$SESSION/manifest.json`; older manifests without `agent` default to Claude. `CCAIRGAP_AGENT` from the running container wins over the manifest when present. `--agent claude|codex` overrides both, but Codex attach is rejected if the running container does not expose `CODEX_HOME`.

Attach is the only subcommand with a selected-agent passthrough tail. Claude attach uses the same Claude denylist as launch. Codex attach uses the interactive Codex allowlist from §"Codex launch semantics"; unsafe or unknown Codex flags fail before `docker exec`.

**Mechanism.**

1. Probe `docker inspect ccairgap-<id>`. Abort with a clear error if the container is missing or not in `State.Running == true`. (Authoritative single-shot check; `runningContainerNames()` set-membership is too coarse for the attach error message.)
2. Read `CCAIRGAP_CWD` from `Config.Env` off the inspect output (the launch flow sets this env var so the entrypoint can `cd` to the workspace at startup; `Config.WorkingDir` is unset because the CLI does not pass `docker run -w`). `<id>` itself comes from argv.
3. Generate a 4-hex random suffix via `crypto.randomBytes(2).toString("hex")`. Final attached label is `<id>#<rand4>` for TUI disambiguation. Stateless; no slot tracking, no IPC.
4. Exec `docker exec -it --user $(id -u):$(id -g) -w <workdir-from-CCAIRGAP_CWD> -e CCAIRGAP_NAME="<id>#<rand4>" ccairgap-<id> ...`. Claude runs as `claude --dangerously-skip-permissions`; Codex runs as `codex --dangerously-bypass-approvals-and-sandbox --no-daemon --cd <workdir-from-CCAIRGAP_CWD>`. Stdio inherited. CLI exit code mirrors the `docker exec` exit code so shell composition (`ccairgap attach foo && …`) works.

**Workdir is inherited from PID 1.** In a multi-repo session, that means the attached agent lands in the primary `--repo` workspace just like the original. No `--repo` selector flag — the user `cd`s manually if they need a different repo. Single-repo policy: attach exposes the same one repo PID 1 sees, no more.

**Lifecycle.**

- Container lifecycle is bound to PID 1 only. Exiting the attached agent (normal exit, Ctrl-C, SIGKILL of the `docker exec` subprocess) does **not** terminate the container; PID 1's agent keeps running.
- Conversely, exiting PID 1 terminates the container, which kills every attached agent immediately. Same for SIGKILL of PID 1.
- **Handoff fires only on PID-1 exit.** Attached agents write into the same session-local state as PID 1, so the existing handoff step picks up the artifacts for that selected agent — no per-attach tracking required.
- An attached agent crashing or being killed leaves no host-side residue. There is no per-attach session dir, no per-attach branch, no per-attach manifest entry.

**Authentication.** Attached Claude shares the same in-container `~/.claude/` and bind-mounted `/host-claude-creds-dir/.credentials.json` as PID 1. Lock-coordinated refresh via `proper-lockfile` (see §"Authentication flow") already serializes concurrent refreshers. Attached Codex shares the session-local `CODEX_HOME=/home/claude/.codex`; auth is copied in only at launch and is never copied back.

**Security posture is unchanged.** `docker exec` inherits the run-time security flags applied at `docker run` (`--cap-drop=ALL`, `--security-opt=no-new-privileges`, the user's `--docker-run-arg` set). Attach does not add capabilities, mounts, or env vars beyond `CCAIRGAP_NAME`. No new host write paths.

**No resume on attach.** `--resume` would require shuttling a transcript into a running container (out of band of the launch-time `$SESSION/transcripts/` copy path) and is deliberately unsupported. Use `ccairgap -r <id>` to start a fresh session that resumes a transcript instead.

### Manifest fields

`$SESSION/manifest.json` carries a top-level `"version": 1` field plus a `repos` array with one entry per cloned repo. Fields consumed by the handoff routine, `recover`, and orphan-scan include:

- `agent` (`"claude"` or `"codex"`, optional, additive v1): selected agent for the session. Omitted in older manifests; consumers MUST treat absence as `"claude"`.
- `repos[].basename` (string, required): the raw basename of the host repo path.
- `repos[].host_path` (string, required): the absolute host path of the real repo.
- `repos[].alternates_name` (string, optional, additive v1): unique per-repo scratch segment `<basename>-<sha256(host_path)[:8]>`. Handoff/recover/orphan-scan use this to locate `$SESSION/repos/<alternates_name>` on disk. Omitted in sessions written by older CLI builds; consumers MUST fall back to `basename` when absent.
- `codex.host_home` (string, required when Codex state has been prepared for the session): authoritative launch-time host Codex home. Handoff and `recover` use this value for Codex rollout copy-out and do not rediscover `$CODEX_HOME`.

## Shell completion

Backed by [`@pnpm/tabtab`](https://www.npmjs.com/package/@pnpm/tabtab) — the same library pnpm uses. Host-side only; nothing about completion crosses the container boundary.

**Install.** `ccairgap install-completion [bash|zsh|fish]` calls `tabtab.install({ name: "ccairgap", completer: "ccairgap", shell })`. tabtab writes one `[[ -f <tabtab-script> ]] && source …` line into the target rc file (`~/.bashrc` / `~/.zshrc` / `~/.config/fish/config.fish`) — exactly one line, no matter how many times the command is run. The shell script itself lives under `~/.config/tabtab/` and defers every completion request back to `ccairgap completion-server` via env vars.

**Uninstall.** `ccairgap uninstall-completion` calls `tabtab.uninstall({ name: "ccairgap" })`, which removes the source line from every rc it finds and deletes the tabtab-managed scripts when no other program is using them. Idempotent.

**Callback.** `ccairgap completion-server` is the handler the shell function invokes at completion time. It reads tabtab's `COMP_*` env vars via `parseEnv(process.env)`, decides what candidates apply to the current word, and emits them to stdout via `tabtab.log(candidates, shell, console.log)`. The subcommand is hidden from `--help` but is a real commander subcommand, so the pre-split guard recognizes it and drops tabtab's callback tail cleanly.

**Candidates.** Static set = commander subcommand names (including `exec`) + long-form flag names of the default launch command, introspected from the same `program` instance that parses real invocations (so the two never drift). Dynamic candidates extend the static set by `prev` word:

| When `prev` is… | Candidates |
|---|---|
| `attach` | `--agent` plus session ids. |
| `recover`, `discard` | Session ids — directory names under `$XDG_STATE_HOME/ccairgap/sessions/`, filtered to those whose container is not currently running. Reuses `scanOrphans`. |
| `-r`, `--resume` | Custom titles of transcripts under `~/.claude/projects/<encoded-workspace-cwd>/*.jsonl`. Reuses `listProjectSessions` from `resumeResolver.ts` (head+tail 64 KiB scan per transcript). Requires a workspace repo (cwd-as-repo or previously-passed `--repo`); absent → no candidates. |
| `--agent` | `claude`, `codex`. |
| `install-completion` | `bash`, `zsh`, `fish`. |
| any other flag | No dynamic completion — tabtab falls back to filesystem completion where appropriate. |

The static set also includes `codex-args` so config-key-oriented shells can surface the selected Codex passthrough key alongside the launch flags.

Completion currently receives previous-token context only. It intentionally does not parse a full command line for deeper command-aware completion after `ccairgap exec -- ...`.

**Failure mode.** Any scan error inside the callback is swallowed — completion emits nothing rather than a stacktrace. Exit code is always 0 so the shell completion function doesn't render shell-level errors during tab-press.

**Host writable paths invariant is unchanged.** tabtab writes to `~/.bashrc` / `~/.zshrc` / `~/.config/fish/config.fish` and `~/.config/tabtab/` only during `install-completion` / `uninstall-completion`, which are explicit user actions on the host, never reached by the launch pipeline. The callback (`completion-server`) is read-only.

## Known constraints

- **No `git gc --prune=now` on host during session.** The session clone references host objects via alternates; pruning host breaks the session.
- **Submodules not supported.** `.gitmodules` is copied into the session clone but submodule `.git/` dirs are not RO-mounted. `git submodule update --init` inside the container falls back to fetching from each submodule's remote URL (works for public submodules, fails for private). Work inside the container proceeds without initialized submodules.
- **macOS only tested.** Linux should work; Windows / WSL2 may need path adjustments.
- **Docker required.** No Podman-specific handling.
- **Single concurrent session per host recommended.** Multiple simultaneous sessions work but share `$XDG_STATE_HOME/ccairgap/output/`. Ids are `<prefix>-<4hex>`; per §"Session identifier" the hex suffix is randomized so concurrent sessions with the same prefix have a 1/65536 collision probability per pair. On collision, the second `docker run` fails cleanly and the CLI aborts with a message; no half-created state remains beyond the session dir, which `ccairgap discard <id>` clears.
- **MCP servers that require host resources (docker.sock, local sockets, host binaries) will not work** unless the user extends the Dockerfile. Intentional.

## Out of scope

- Automatic extraction of Claude's output beyond git branches (bundles, patch files) — user can ask Claude to drop artifacts in `/output` manually.
- Per-MCP allowlisting — user customizes the Dockerfile.
