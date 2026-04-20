# ccairgap — Spec

Run `claude --dangerously-skip-permissions` in a Docker container so you can hand it a task and walk away. Exfiltration is an accepted risk; host state destruction is not.

## Goal

- Full-permission Claude Code inside a container.
- Host filesystem physically unable to be destroyed or mutated outside a small set of explicitly writable paths.
- Container work product (branches, transcripts) reachable on the host after session ends, without requiring the container to have write access to host state during the session.
- Behavior parity with host Claude: same plugins, skills, slash commands, global CLAUDE.md, settings, MCP configuration.

## Threat model

- **Accepted:** full exfiltration. Anything the container can read may be sent over the network.
- **Not accepted:** any write to host filesystem outside the small set of explicitly writable paths listed in §"Host writable paths". Specifically: real git repositories, host `~/.claude/`, host `~/.claude.json`, and anything else on disk must survive the session byte-for-byte.
- **Container escape:** not part of the threat model. The CLI's built-in docker invocation does not lower default Docker isolation (no `--privileged`, no `SYS_ADMIN`, no `docker.sock` mount). Users can opt into any docker flag via `--docker-run-arg` (see §"Raw docker run args"); that surface is user-foot-gun territory, not a defense claim.

## Implementation

- **Language:** TypeScript, compiled to a single bundled JS file with [tsup](https://tsup.egoist.dev/).
- **Runtime:** Node.js ≥ 20 on the host. The container uses its own Node 20 base image independently.
- **Distribution:** npm package `ccairgap`. Primary install path is `npm i -g ccairgap`; `npx ccairgap …` works for one-shot use.
- **Package layout:**
  - `dist/cli.js` — bundled entry, declared in `package.json` `bin`.
  - `docker/Dockerfile` — shipped as a package asset; copied out or read by the CLI at build time.
  - `docker/entrypoint.sh` — runs inside the container; stays in bash (fixed Alpine-ish environment, no portability concerns).
- **Dependencies kept lean:** `commander` for arg parsing, `execa` for shelling out to `docker` / `git`. No runtime dep on external config libraries.
- **License:** MIT.
- **Repository:** `github.com/alfredvc/ccairgap`.

## Versioning

- **CLI:** semver. Patch = bug fixes, minor = new flags / new optional manifest fields, major = flag rename or removal, manifest shape change, or state-dir layout change.
- **Container image tag** = CLI version + content hash of `Dockerfile`+`entrypoint.sh` (or `custom-<hash>` when built from a user Dockerfile). See §"Container image".
- **Claude Code inside the image:** defaults to the host's installed Claude Code version at build time (detected via `claude --version`). Falls back to `latest` if detection fails. Users can override via `--docker-build-arg CLAUDE_CODE_VERSION=<semver>` or `CCAIRGAP_CC_VERSION=<semver>`.
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

## Host writable paths (the only ones)

A session may cause writes to:

1. `$XDG_STATE_HOME/ccairgap/sessions/<id>/` — session scratch, created fresh, deleted on exit after transcripts copy. Includes `$SESSION/creds/.credentials.json` on macOS (see §"Authentication flow") and `$SESSION/hook-policy/` (patched settings + per-plugin / per-repo hook overlays; see §"Hook policy").
2. `$XDG_STATE_HOME/ccairgap/output/` — `/output` mount inside container, plus `output/<id>/<abs-src>/` subtrees written by the exit-trap for every `--sync` path.
3. `~/.claude/projects/<path-encoded-cwd>/` — transcript copy-back on exit.
4. Real host repos passed to `--repo` and `--extra-repo`: **only** the ref `ccairgap/<id>` is created via `git fetch` on exit. No other mutations. `.git/objects` is RO-mounted into the container.
5. User-declared `--mount <path>` targets — live RW bind-mount from container to host. Opt-in per path. This class of write can mutate arbitrary host state during a running session and exists to support artifact caches (e.g. `node_modules`) the user explicitly trusts the container with.
6. Anything a user adds via `--docker-run-arg` (see §"Raw docker run args"). Raw docker args are pass-through: a `-v <host>:<ctr>:rw`, `--mount`, `--pid=host`, etc. supplied this way can make host writes or weaken isolation beyond `--mount`'s narrow per-path semantics. Treated as user-declared opt-out.
7. `$SESSION/clipboard-bridge/current.png` — image bytes written by the host-side clipboard watcher. Created on launch when clipboard passthrough is active; removed on handoff.

No other host path is writable by the container. `~/.claude/`, `~/.claude.json`, plugin marketplace repos, `--ro` reference paths are all RO-mounted.

## Command line interface

```
ccairgap [SUBCOMMAND] [OPTIONS]
```

Default (no subcommand): start a new session.

**Launch flags** (apply to the default `ccairgap` invocation):

| Flag | Repeatable | Description |
|------|------------|-------------|
| `--repo <host-path>` | no | Host repo exposed as the workspace (container cwd). Cloned with `--shared`, new branch `ccairgap/<id>` created. If omitted, defaults to the current working directory (must be a git repo). |
| `--extra-repo <host-path>` | yes | Additional host repo mounted alongside `--repo`. Same `--shared` clone + `ccairgap/<id>` branch, but not the workspace. Use for sibling repos Claude reads but does not work in as its primary target. |
| `--ro <host-path>` | yes | Additional read-only bind mount. Path can be anything — a git repo, a docs dir, any reference material. `--ro` never creates a sandbox branch; Claude gets read-only visibility. |
| `--cp <path>` | yes | Copy host path into the session at launch; container sees it RW at the same absolute path. Changes are discarded on exit (never reach host). Relative paths resolve against the workspace repo root. See §"Build artifact paths". |
| `--sync <path>` | yes | Same pre-launch copy as `--cp`, plus: on exit the container-written copy is rsynced to `$CCAIRGAP_HOME/output/<id>/<abs-source-path>/`. The original host path is never written to. See §"Build artifact paths". |
| `--mount <path>` | yes | RW bind-mount host path directly into the container at the same absolute path. Live host writes; no copy. Relative paths resolve against the workspace repo root. Breaks the "container never writes host repo directly" invariant for the declared path only — opt-in. See §"Build artifact paths". |
| `--base <ref>` | no | Base ref for `ccairgap/<id>` branch. Default: current HEAD of each repo (`--repo` + every `--extra-repo`). |
| `--keep-container` | no | Omit `docker run --rm`. Container persists after exit for postmortem via `docker logs` / `docker exec`. Manual cleanup: `docker rm ccairgap-<id>`. |
| `--dockerfile <path>` | no | Build from a user-supplied Dockerfile instead of the bundled one. Resulting image tag carries a `custom-<hash>` suffix (see §"Container image"). |
| `--docker-build-arg KEY=VAL` | yes | Forwarded to `docker build --build-arg`. Common use: `CLAUDE_CODE_VERSION=1.2.3` to pin Claude Code. |
| `--rebuild` | no | Force rebuild of the container image before launching, even if the tag already exists locally. |
| `-p, --print <prompt>` | no | Run Claude Code in non-interactive print mode: `claude -p "<prompt>"` instead of the REPL. The container still runs with full permissions and all mounts; it just does a single prompt and exits. Useful for smoke tests and scripted runs. |
| `-r, --resume <id-or-name>` | no | Resume an existing Claude session inside the sandbox. Accepts **either** a session UUID **or** the session's custom title (what `claude` prints on exit). Titles are matched case-insensitively and must be exact; 0 or >1 matches abort launch with a candidate list. The CLI copies `~/.claude/projects/<encoded-workspace-cwd>/<uuid>.jsonl` (plus the optional `<uuid>/` subagents dir) into `$SESSION/transcripts/` before `docker run`. Inside the container, `claude -r "$CCAIRGAP_RESUME"` always uses the resolved UUID (not the raw name). Requires a workspace repo; errors under `--bare` / ro-only. Works with both host-born and ccairgap-born sessions — no separate UX per origin. Config key: `resume: <id-or-name>` (scalar). |
| `-n, --name <name>` | no | Session id **prefix**. The CLI always appends a 4-hex suffix, so the final `<id>` is `<name>-<4hex>`. Drives the sandbox branch (`ccairgap/<id>`), docker container (`ccairgap-<id>`), session dir, and Claude's session label (`-n "<name>"`, rewritten to `[ccairgap] <name>` by the UserPromptSubmit hook on first prompt; see §"Container entrypoint" for the full precedence). Validated once via `git check-ref-format refs/heads/ccairgap/<id>`; the CLI aborts before any side effects if `<name>` would produce an invalid ref. On collision with an existing session dir, container (running or stopped), or branch in the workspace repo (`--repo`), the hex suffix is re-rolled up to 8 times before aborting. `--extra-repo` branches are not pre-checked, so a stale branch in one of them surfaces at fetch time on exit. Omitted, a random `<adj>-<noun>` prefix is generated — see §"Session identifier". |
| `--hook-enable <glob>` | yes | Opt-in a Claude Code hook whose raw `command` string matches `<glob>`. All hooks are **disabled by default** inside the sandbox — the host's hook commands typically reference host binaries (`afplay`, project-local `python3` scripts, etc.) that don't exist in the container and would fail every tool call. Each `--hook-enable` adds one glob; the full set is matched against hooks from every source (user settings, enabled plugins, project settings). See §"Hook policy". Repeatable. |
| `--docker-run-arg <args>` | yes | Extra args appended to the `docker run` command. Value is shell-split via `shell-quote`, so `--docker-run-arg "-p 8080:8080"` expands to two tokens. Appended after all built-in args so docker's last-wins semantics let user args override defaults (`--network`, `--cap-drop`, etc.). Repeatable. See §"Raw docker run args". |
| `--no-warn-docker-args` | no | Suppress the "dangerous token" warning emitted when `--docker-run-arg` contains flags known to weaken isolation (`--privileged`, `--cap-add`, `--network=host`, `docker.sock`, …). Warning-only; never blocks. |
| `--bare` | no | Launch a "naked" container: no config-file loading, no workspace-repo inference from cwd. User mounts whatever they need via `--repo` / `--extra-repo` / `--ro` / `--cp` / `--sync` / `--mount`. All Claude config flow is unchanged (`~/.claude` RO mount, credentials, plugins cache, etc.). See §"Bare mode". |
| `-- <claude-args…>` | no | Tokens after `--` are forwarded verbatim to the in-container `claude` invocation, subject to a small denylist (see §"Claude arg passthrough"). Example: `ccairgap --repo . -- --model opus --effort high`. Config equivalent: `claude-args: [<token>, …]`. Config and CLI tails are concatenated (config first, CLI appended); claude's last-wins arg parser handles duplicates. |

No `--auth` or `--profile` flags. Credentials are inherited from the host's `~/.claude/` via RO mount. If you are not logged in on the host, run `claude` on the host first.

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `list` | List orphaned sessions (session dirs on disk with no running container). Prints timestamp, repos involved, and commit counts on `ccairgap/<id>`. |
| `recover [<id>]` | Run the handoff routine against `$SESSION/<id>/`. Idempotent. With no `<id>` argument, equivalent to `list`. |
| `discard <id>` | Delete `$SESSION/<id>/` without running handoff. Use when you don't want the sandbox branch in your real repo. |
| `doctor` | Preflight checks (Docker running, host credentials present, state dir writable, `git` + `rsync` + `cp` on PATH, image present/stale). Also hash-compares any sidecar `Dockerfile` / `entrypoint.sh` under `<git-root>/.ccairgap/` against the bundled copies and warns on drift — useful after a CLI upgrade to decide whether to re-run `ccairgap init --force`. |
| `inspect` | Enumerate the full config surface ccairgap would see at launch: hook entries, MCP server definitions, `env` vars, and `extraKnownMarketplaces` entries across every source (user `~/.claude/settings.json`, each enabled plugin, `.claude/settings.json[.local]` under `--repo` + every `--extra-repo`, `~/.claude.json`, and `<repo>/.mcp.json`). Output is JSON `{hooks, mcpServers, env, marketplaces}` to stdout; `--pretty` renders human-readable tables instead. Read-only; no session is created and no files are mutated. Accepts the same `--config` / `--repo` / `--extra-repo` inputs as launch so the enumeration matches what a real launch would filter. See §"Hook policy". |
| `init` | Materialize the bundled `Dockerfile`, `entrypoint.sh`, and a minimal `config.yaml` (with `dockerfile: Dockerfile`) into `<git-root>/.ccairgap/` — or `dirname(--config)` if `--config` is passed. Fails if any of the three target files exist; `--force` overwrites all three. Intended for users who want to customize the container image without forking the repo. See §"Container image customization". |

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

# Force image rebuild with a pinned Claude Code version
ccairgap --rebuild --docker-build-arg CLAUDE_CODE_VERSION=1.2.3 --repo ~/src/foo
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
2. Subcommand dispatch: if the first positional is `list`, `recover`, `discard`, `doctor`, `inspect`, or `init`, run that handler per §Recovery / §Doctor / §"Container image customization" / §"Hook policy" and exit. Any other first positional errors with `unknown command '<x>'` and exit 1 — this prevents typos like `ccairgap lsit` from silently falling through to the launch flow. Launch flags are only consumed by the default (no-subcommand) invocation.
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
    - User-supplied `--docker-run-arg` tokens appended after all built-ins (see §"Raw docker run args")
    - Image: `ccairgap:<cli-version>-<sha256(Dockerfile+entrypoint.sh)[:8]>` by default, or `ccairgap:custom-<sha256(dockerfile)[:12]>` if `--dockerfile` was passed. Build if the tag is missing locally, or if `--rebuild` was passed.
13. Install exit trap: run §"Handoff routine" against `$SESSION/<id>/`.
14. Exec the `docker run` command.

## Config file

YAML file that mirrors launch flags. Default locations (checked in order): `<git-root>/.ccairgap/config.yaml`, then `<git-root>/.config/ccairgap/config.yaml`. Override: `--config <path>` or `--profile <name>`.

- **Load:** the CLI walks up from `cwd` to find the git root; it checks `<git-root>/.ccairgap/config.yaml` first, then `<git-root>/.config/ccairgap/config.yaml`; the first one found is loaded. If both exist, `.ccairgap/config.yaml` takes precedence and a warning is printed to stderr. `--config <path>` skips the walk and loads the given file (absolute or `cwd`-relative); missing file is a hard error.
- **Profiles:** `--profile <name>` loads `<git-root>/.ccairgap/<name>.config.yaml` (fallback `<git-root>/.config/ccairgap/<name>.config.yaml`) instead of the default `config.yaml`. `--profile default` is equivalent to no flag (loads `config.yaml`). Missing profile file is a hard error (unlike the silent walk-fallback for the default). Profile names must match `[A-Za-z0-9._-]+`. `--config` and `--profile` are mutually exclusive. Relative-path anchoring (see §"Relative path resolution") treats profile files identically to `config.yaml` — same canonical-dir detection, so `repo: .` in `web.config.yaml` still means the git root. Profiles are a filename lookup only: no inheritance, no merge between profiles.
- **Key surface:** every launch flag has a config-file key (kebab-case and camelCase both accepted). Unknown keys and wrong types abort launch with a clear error. `src/config.ts` is source of truth.
- **Precedence:** CLI > config > built-in defaults. Scalars: CLI wins if passed. Arrays (`extra-repo`, `ro`, `cp`, `sync`, `mount`, `docker-run-arg`, `hooks.enable`): concat (config first, CLI appended; no dedup). Maps (`docker-build-arg`): per-key merge, CLI wins on overlap.
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

docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"
docker-run-arg:
  - "-p 8080:8080"
hooks:
  enable:
    - "python3 *"

# Forwarded verbatim to the in-container `claude` (subject to the denylist
# in §"Claude arg passthrough"). Concatenated with the CLI `--` tail.
claude-args:
  - --model
  - opus
  - --effort
  - high
```

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

## Container mount manifest

| Host source | Container path | Mode | Notes |
|-------------|----------------|------|-------|
| `~/.claude/` (resolved) | `/host-claude` | ro | Entrypoint rsyncs contents to `~/.claude/` (settings, plugins minus cache, skills, commands, CLAUDE.md, statusline). `.credentials.json` and `.DS_Store` are excluded from the copy — see the `/host-claude-creds` row for credentials. |
| `~/.claude.json` (resolved) | `/host-claude-json` | ro | Fallback source only — used when the MCP-policy patched copy is absent. Entrypoint normally overlays `/host-claude-patched-json` over this and then applies the jq onboarding patch. |
| macOS: `$SESSION/creds/.credentials.json` / Linux: `~/.claude/.credentials.json` | `/host-claude-creds` | ro | Single-file mount. Entrypoint copies to `~/.claude/.credentials.json`, chmod 600. See §"Authentication flow". |
| `$SESSION/hook-policy/user-settings.json` | `/host-claude-patched-settings.json` | ro | Single-file mount. Host-built copy of `settings.json` with `hooks` filtered per `--hook-enable` (empty list → `hooks: {}`) and `disableAllHooks: false` forced. Entrypoint overlays it on the rsync'd `~/.claude/settings.json` before the env-merge jq step. See §"Hook policy". |
| `$SESSION/hook-policy/plugins/<market>/<plugin>/<ver>/hooks.json` | `/home/claude/.claude/plugins/cache/<market>/<plugin>/<ver>/hooks/hooks.json` | ro | Nested single-file overlay on top of the RO plugin cache. One mount per enabled cache-backed plugin that ships a `hooks/hooks.json`. Always present (filtered = `{}` for the empty enable list). |
| `$SESSION/hook-policy/dir-plugins/<market>/<plugin>/hooks.json` | `<pluginDir>/hooks/hooks.json` | ro | Nested single-file overlay on top of the directory-sourced marketplace RO mount. One mount per enabled directory-sourced plugin that ships `hooks/hooks.json`. Always present. |
| `$SESSION/hook-policy/projects/<repo>/settings.json` (and `.local`) | `<original-host-path>/.claude/settings.json` (and `.local`) | ro | Nested single-file overlay on top of the session-clone's `.claude/` dir. One mount per repo `.claude/settings.json[.local]` that declares hooks. Always present. |
| `$SESSION/mcp-policy/claude-json.json` | `/host-claude-patched-json` | ro | Single-file mount. Host-built copy of `~/.claude.json` with user-scope and every user-project-scope `mcpServers` filtered per `--mcp-enable` (empty list → `mcpServers: {}` at every scope). Entrypoint overlays it in place of `~/.claude.json` before the jq onboarding patch. Always present. See §"MCP policy". |
| `$SESSION/mcp-policy/plugins/<market>/<plugin>/<ver>/{.mcp.json,plugin.json}` | `/home/claude/.claude/plugins/cache/<market>/<plugin>/<ver>/{.mcp.json,plugin.json}` | ro | Nested single-file overlay on top of the RO plugin cache. One mount per enabled cache-backed plugin file that declares `mcpServers`. Always present when source exists. |
| `$SESSION/mcp-policy/dir-plugins/<market>/<plugin>/{.mcp.json,plugin.json}` | `<pluginDir>/{.mcp.json,plugin.json}` | ro | Nested single-file overlay on top of the directory-sourced marketplace RO mount. One mount per enabled directory-sourced plugin file that declares `mcpServers`. Always present when source exists. |
| `$SESSION/mcp-policy/projects/<repo>/.mcp.json` | `<original-host-path>/.mcp.json` | ro | Nested single-file overlay on top of the session clone. One mount per repo whose `.mcp.json` exists. Filtered by glob **and** host approval state — servers approved on host via `enabledMcpjsonServers` / `enableAllProjectMcpServers` and matching the glob survive; everything else is stripped. |
| `~/.claude/plugins/cache/` (resolved) | `/home/claude/.claude/plugins/cache/` | ro | RO-mount stays even after entrypoint copy so this big dir is not duplicated into container FS. |
| `~/.claude/plugins/` (resolved) | `<host-abs-path>/.claude/plugins/` | ro | Second RO mount of plugins tree at the original host absolute path. `known_marketplaces.json` (`installLocation`) and `installed_plugins.json` (`installPath`) store absolute host paths; without a mount at the real host path, Claude Code startup fails with "Plugin X not found in marketplace Y" for `github`/`git`/`npm`/`url`-sourced marketplaces. Skipped when host `~/.claude` coincides with container `$HOME/.claude` (no new path). |
| `$SESSION/transcripts/` | `/home/claude/.claude/projects/` | rw | Transcripts write target. |
| `$XDG_STATE_HOME/ccairgap/output/` | `/output` | rw | Artifact drop. |
| `$SESSION/repos/<basename>-<sha256(hostPath)[:8]>/` | `<original-host-path>` | rw | Session clone. The `<sha256>` suffix disambiguates multi-repo sessions where two `--repo`/`--extra-repo` paths share a basename. |
| `<resolved-git-dir>/objects/` | `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/objects/` | ro | Alternates target for `--shared` clone. The `<sha256>` suffix disambiguates multi-repo sessions where two `--repo`/`--extra-repo` paths share a basename. The session clone's `.git/objects/info/alternates` is rewritten to this container path so new commits write to the session clone's own RW `objects/` while historical reads resolve through here. See §"Repository access mechanism". |
| `<resolved-git-dir>/lfs/objects/` | `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/lfs/objects/` | ro | LFS content. Session clone's `.git/lfs/objects/` is replaced with a symlink to this path. Mount is optional — skipped if source dir doesn't exist. |
| `<--ro path>` | `<original-host-path>` | ro | Reference material. |
| `<plugin-marketplace-path>` | `<original-host-path>` | ro | Auto-discovered from settings.json. |
| `$SESSION/artifacts/<abs-src>/` (pre-copied from host) | `<original-host-path>` | rw | `--cp` / `--sync` with an absolute source **outside** any repo. Source outside any repo has no covering mount, so the pre-launch copy needs its own bind. For `--cp`/`--sync` sources **inside** a repo, the copy lands inside the session clone and rides on the existing `$SESSION/repos/<basename>-<sha256(hostPath)[:8]>/` mount — no extra entry here. Appended after repo mounts. |
| `<--mount path>` | `<original-host-path>` | rw | User-declared RW bind. Appended after repo mounts so it overrides any session-clone or `--cp`/`--sync` copy at the same path. |
| `$SESSION/clipboard-bridge/` (directory) | `/run/ccairgap-clipboard/` | ro | Host clipboard bridge dir. Omitted when `--no-clipboard` or unsupported host. |

Absolute paths are preserved between host and container so `settings.json` references resolve identically.

### Mount-collision policy

Before invoking `docker run`, ccairgap resolves mount conflicts in two passes:

1. **Marketplace pre-filter (`filterSubsumedMarketplaces`).** If a plugin marketplace path from `extraKnownMarketplaces` equals or is nested inside any `--repo`/`--extra-repo` `hostPath`, the marketplace mount is dropped. The repo's session-clone RW mount serves those files at the same container path. A stderr warning notes the drop and reminds users that the container sees HEAD-only content (uncommitted files in the marketplace tree are not visible).
2. **Collision resolver (`resolveMountCollisions`).** Defense-in-depth at the end of `buildMounts`:
   - Any two surviving mounts sharing a container `dst` throw with both source labels (`--repo/--extra-repo`, `--ro`, `--mount`, `plugin marketplace`, etc.).
   - User-source mounts may not use reserved container paths: `/output`, `/host-claude`, `/host-claude-json`, `/host-claude-creds`, `/host-claude-patched-settings.json`, `/host-claude-patched-json`, `<home>/.claude/projects`, `<home>/.claude/plugins/cache`, anything under `/host-git-alternates/`.

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

**Distribution model:** the image is built locally on first use from a Dockerfile shipped inside the npm package. No registry pull. The user can substitute their own Dockerfile via `--dockerfile <path>`.

**Base:** `node:20-slim` (latest LTS).

**Installed:**
- Claude Code via the native installer (`https://claude.ai/install.sh`), installed as the `claude` user into `~/.local/bin/claude`. Version controlled via `ARG CLAUDE_CODE_VERSION` (default: host version detected at build time; `latest` if undetectable). Override via `--docker-build-arg CLAUDE_CODE_VERSION=<semver>`. Native install avoids the npm-to-native-installer migration nag that `@anthropic-ai/claude-code` triggers since v2.1.15.
- `git`, `git-lfs`, `curl`, `jq`, `rsync`, `ca-certificates`, `less`, `vim`.

Apt invocation pattern (all package installs):
```dockerfile
RUN DEBIAN_FRONTEND=noninteractive apt-get update \
 && apt-get install -y --no-install-recommends \
    <packages> \
 && rm -rf /var/lib/apt/lists/*
```

`DEBIAN_FRONTEND=noninteractive` suppresses debconf prompts. `--no-install-recommends` keeps image minimal. `rm -rf /var/lib/apt/lists/*` after install strips the package index.

Not installed: `tmux` (user handles tmux outside the container).

**User:** non-root `claude` at UID/GID matching the host user for bind-mount compatibility. UID and GID are not baked into the Dockerfile — the CLI passes them as build args at build time:

```bash
docker build \
  --build-arg HOST_UID=$(id -u) \
  --build-arg HOST_GID=$(id -g) \
  --build-arg CLAUDE_CODE_VERSION=2.1.89 \
  -t ccairgap:<cli-version>-<hash8> .
```

Dockerfile (condensed):
```dockerfile
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG CLAUDE_CODE_VERSION=latest
# user created first so native installer lands in /home/claude/.local/bin
RUN groupadd -g ${HOST_GID} claude \
 && useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash claude
USER claude
ENV PATH=/home/claude/.local/bin:$PATH
RUN if [ "${CLAUDE_CODE_VERSION}" = "latest" ]; then \
        curl -fsSL https://claude.ai/install.sh | bash; \
    else \
        curl -fsSL https://claude.ai/install.sh | bash -s "${CLAUDE_CODE_VERSION}"; \
    fi
```

Docker's layer cache handles rebuild on UID/GID change — the CLI always passes the args, Docker reuses layers when the values haven't changed.

**Image tagging scheme:**

| Invocation | Tag |
|------------|-----|
| Default | `ccairgap:<cli-version>-<sha256(Dockerfile+entrypoint.sh)[:8]>` |
| `--dockerfile <path>` | `ccairgap:custom-<sha256(dockerfile)[:12]>` |

Both suffixes are deterministic: identical content always produces the same tag, so rebuilds are skipped when nothing changed. The default tag includes a content hash over both baked files so edits to either the Dockerfile or `entrypoint.sh` (shipped with a CLI upgrade, or a manual patch) produce a new tag and auto-trigger a rebuild on next launch. Custom and default tags coexist without collision.

**Rebuild triggers** (the CLI builds the image only if one of these applies):
1. No local image matches the computed tag (covers: first run, CLI upgrade with new version, edits to bundled `Dockerfile` / `entrypoint.sh`, edits to a custom Dockerfile).
2. `--rebuild` was passed.

Image age is never auto-rebuilt. `ccairgap doctor` surfaces a warning if the current image is older than a threshold (default: 14 days) so the user can explicitly `--rebuild`. `doctor` also lists older `ccairgap:<cli-version>-*` tags that linger after content-hash changes so the user can prune them manually with `docker image rm` — the CLI never removes images itself.

## Container image customization

Two supported paths to change what's inside the image:

1. **`--docker-build-arg KEY=VAL`** — the bundled Dockerfile exposes `CLAUDE_CODE_VERSION`. Pin Claude Code without touching the Dockerfile.
2. **Sidecar Dockerfile via `ccairgap init`** — materialize the bundled `Dockerfile` + `entrypoint.sh` into the config dir (default `<git-root>/.ccairgap/`, or `dirname(--config)` if `--config` is passed). Edit in place. The generated `config.yaml` wires `dockerfile: Dockerfile` so subsequent launches build from the sidecar copy (image tag becomes `ccairgap:custom-<sha256[:12]>` per §"Container image"). No need to fork the repo.

`ccairgap init` writes three files: `Dockerfile`, `entrypoint.sh`, `config.yaml`. If any of the three already exist, `init` aborts with an error listing them; `--force` overwrites all three unconditionally (no merge — any prior edits to `config.yaml` are lost).

`ccairgap doctor` hash-compares the sidecar `Dockerfile` / `entrypoint.sh` against the bundled copies shipped with the installed CLI version and warns when they diverge — useful after a CLI upgrade to decide whether to re-run `ccairgap init --force` (destructive; overwrites local edits) or keep custom changes.

## Entrypoint

Runs at container start. Steps:

1. `mkdir -p /home/claude/.claude`
2. Copy `/host-claude/` → `/home/claude/.claude/` with `rsync -rL --chmod=u+w` (transform symlinks into files, ensure writable in destination). Exclude these session-local entries so we don't drag host state into the container's fresh session view: `projects/`, `sessions/`, `history.jsonl`, `todos/`, `shell-snapshots/`, `debug/`, `paste-cache/`, `session-env/`, `file-history/`. Also exclude `plugins/cache/` (RO-mounted separately at the same container path), `.credentials.json` (handled in the next step), and `.DS_Store` (macOS metadata at any depth — often has ACLs that break copies).
3. If `/host-claude-creds` exists, `cp -L /host-claude-creds /home/claude/.claude/.credentials.json` and `chmod 600` the destination.
4. Copy `~/.claude.json` source → `/home/claude/.claude.json`. The MCP-policy overlay wins: if `/host-claude-patched-json` is mounted (strips user + user-project `mcpServers` per `--mcp-enable`), use it as the source; otherwise fall back to `/host-claude-json`. See §"MCP policy".
5. Patch `/home/claude/.claude.json` via `jq` to ensure:
   - `hasCompletedOnboarding: true`
   - `projects.<cwd>.hasTrustDialogAccepted: true` for each session repo's cwd
   - `installMethod` and `autoUpdatesProtectedForNative` deleted (the container runs a native install at `/home/claude/.local/bin/claude`; deleting these fields lets Claude Code re-detect its install method from the binary path rather than inheriting stale host values)
6. If `/host-claude-patched-settings.json` exists, `cp -L` it over `/home/claude/.claude/settings.json` before proceeding. This is the hook-policy overlay: a host-built copy of `settings.json` with `hooks` filtered per `--hook-enable` (empty list → `hooks: {}`) and `disableAllHooks: false` forced (so the custom `statusLine` survives). The next step's env merge layers on top of the filtered hooks.
7. Merge overrides into `/home/claude/.claude/settings.json`. `.env` merged with `jq '.env = (.env // {}) + { ... }'` to preserve existing entries; `skipDangerousModePermissionPrompt` set to `true` to suppress the bypass-permissions startup warning inside the sandbox:
   ```json
   {
     "env": {
       "DISABLE_AUTOUPDATER": "1",
       "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
       "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1"
     },
     "skipDangerousModePermissionPrompt": true
   }
   ```
8. If no `--repo` was passed (ro-only session), cwd defaults to `/workspace` (simple fallback). Otherwise cwd = `--repo`'s preserved path (the workspace). `--extra-repo` entries are mounted at their preserved paths but never become cwd.
9. Build the final `claude` args: always `--dangerously-skip-permissions`; then label, resume, passthrough, and (optionally) print:
   - **Label (`-n`):** `CCAIRGAP_NAME` carries the session id (always set by the CLI). Use `-n "ccairgap $CCAIRGAP_NAME"`. Fallback to `-n "ccairgap"` only when `CCAIRGAP_NAME` is unset (i.e. the entrypoint was launched directly without the CLI env).
   - **Resume (`-r`):** if `CCAIRGAP_RESUME` is set, append `-r "$CCAIRGAP_RESUME"`.
   - **Passthrough (`"$@"`):** the CLI appends filtered claude-args as positional args to `docker run`; they arrive at the entrypoint as `"$@"` and are spliced verbatim. Filtered host-side; the entrypoint does not re-validate. See §"Claude arg passthrough".
   - The `-n` value (`"ccairgap <id>"`) is intentionally **not** the same as the UserPromptSubmit hook's `sessionTitle` output (`"[ccairgap] <id>"`): Claude Code's hook layer dedups against the current title, so if `-n` already matched the hook output, the rename would skip and the TUI's "session renamed" side effects (TextInput border recolor, top-border label) would never fire.
   - Then either `-p "$CCAIRGAP_PRINT"` for non-interactive print mode, or nothing for the interactive REPL. `exec claude …`. `-p` stays the final positional so claude treats `$CCAIRGAP_PRINT` as the prompt argument (claude's prompt-positional convention).

## Authentication flow

Credentials come from the host's existing Claude Code login. Storage location differs per OS, so the CLI normalizes both paths to a single RO mount at `/host-claude-creds` inside the container; the entrypoint copies from there into `~/.claude/.credentials.json`.

- **macOS:** Claude Code stores credentials in the Keychain (item `Claude Code-credentials`). The CLI reads them at launch with `security find-generic-password -w -s "Claude Code-credentials"`, writes the JSON to `$SESSION/creds/.credentials.json` (mode 0600), and bind-mounts that file at `/host-claude-creds`. The materialized file is deleted with the session dir on exit. Keychain ACLs may prompt for approval on first read; grant "Always Allow" to avoid re-prompts.
- **Linux / other:** The CLI bind-mounts host `~/.claude/.credentials.json` directly at `/host-claude-creds`. No session-dir copy is needed.

The entrypoint does `cp -L /host-claude-creds ~/.claude/.credentials.json` and `chmod 600` on the destination. The container's copy is writable, so Claude Code can refresh the access token in-place during the session; the host keychain / credentials file stay untouched.

The `/host-claude` RO mount (the rest of `~/.claude/`) does not include `.credentials.json` — the credentials file is handled solely via `/host-claude-creds` to keep the code path uniform across macOS and Linux.

Behavior:

- Log in on the host once with `claude` (normal host login).
- `ccairgap` inherits those credentials for the duration of the container.
- The container's `~/.claude/` is writable (normal home dir), so session mutations (permission cache, prompt history in `.claude.json`) stay in-container and die with it — host state is untouched.
- To switch accounts, log in differently on the host before launching. Multi-profile support is out of scope.

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
- Docker resolves repeatable flags with last-wins semantics, so `--docker-run-arg "--network my-net"` overrides no built-in network flag (there is none), while `--docker-run-arg "--cap-drop NET_ADMIN"` narrows the earlier `--cap-drop=ALL`.

**Danger warning:**

- Before invoking docker, the CLI scans the parsed tokens for flags known to weaken default isolation: `--privileged`, `--cap-add`, `--security-opt`, `--device`, `--network=host` / `--net=host`, `--pid=host`, `--userns=host`, `--ipc=host`, `--uts=host`, substring `docker.sock`, substring `SYS_ADMIN`, and any `--cap-drop` narrower than `ALL`. Two-token forms (`--network host`, `--cap-add SYS_ADMIN`) are caught alongside the `=host` forms.
- Each hit prints one stderr warning naming the token and the broad reason. The launch still proceeds — this is a nudge, not a gate.
- Scan is best-effort; users can construct equivalent effects via args the scan does not know about. The CLI makes no claim of completeness.
- Silence the warning with `--no-warn-docker-args` (or `warn-docker-args: false` in config).

**Relation to the host-writable-paths invariant:**

- Raw args that add RW mounts (`-v <host>:<ctr>:rw`, `--mount type=bind,source=<host>,...`) expand the writable-paths set beyond what the CLI can see. §"Host writable paths" item 6 records this formally.
- Users who only want per-path host RW should prefer `--mount <path>` — it's narrower in semantics and stays within the structured flag surface.

## Claude arg passthrough

ccairgap forwards `claude` launch flags it does not own from CLI `--` and config `claude-args:` to the in-container `claude` invocation. Forward-compatible: any flag not on the denylist below passes through verbatim, so new Claude Code flags work the day they ship without a ccairgap release.

**Sources:**

- **CLI:** tokens after a bare `--` are the passthrough tail. Example: `ccairgap --repo . -- --model opus --effort high`. The pre-split runs in `src/cliSplit.ts` before commander parses, so the existing unknown-positional guard still catches typos like `ccairgap lsit`. `--` passthrough on a known subcommand (`list`, `recover`, `discard`, `doctor`, `inspect`, `init`) errors with "`--` passthrough is only valid on the default launch command".
- **Config:** `claude-args: [<token>, …]` in YAML (kebab and camelCase aliases both accepted). Same shape as the CLI tail: a list of literal tokens. No map form — `claude-args: {model: opus}` is rejected by `assertStringArray`.
- **Merge:** config tokens come first, CLI tokens append. Claude's last-wins arg parser handles duplicates; users can rely on that to override config values from the CLI (config sets `--model opus`, CLI passes `-- --model sonnet` → claude keeps the last).

**Plumbing:** the merged + filtered list is appended as positional args to `docker run`. Docker forwards them to the entrypoint as `"$@"` (execve-style — no shell parsing, no JSON layer). The entrypoint splices `"$@"` between `RESUME_ARGS` and `-p` in the `exec claude` line. Argv (not env-var JSON) avoids serialization layers and the per-env-var size cap; values with spaces, quotes, or newlines round-trip unchanged.

**Filtering** runs in `src/claudeArgs.ts`. Hard-denied flags abort launch with exit 1 before any session-dir side effects (same ordering as `--resume` validation). Soft-dropped flags are stripped with a stderr warning; launch continues. The entrypoint does not re-validate — the CLI is the trust boundary, not the image.

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

#### SOFT drop (warn on stderr, strip)

| Claude flag | Why |
|-------------|-----|
| `--dangerously-skip-permissions` | already set unconditionally by the entrypoint |
| `--allow-dangerously-skip-permissions` | redundant with the above |

#### Allow (implicit)

Everything not above passes through unchanged. Examples: `--model`, `--effort`, `--agent`, `--agents`, `--permission-mode`, `--append-system-prompt`, `--system-prompt`, `--allowed-tools` / `--allowedTools`, `--disallowed-tools` / `--disallowedTools`, `--tools`, `--fallback-model`, `--verbose`, `--debug`, `--betas`, `--brief`, `--disable-slash-commands`, `--exclude-dynamic-system-prompt-sections`, `--setting-sources`, plus print-mode companions (`--output-format`, `--input-format`, `--max-budget-usd`, `--json-schema`, `--no-session-persistence`, `--include-partial-messages`, `--include-hook-events`, `--replay-user-messages`) — print-mode companions only meaningfully combine with `ccairgap --print`.

### Tokenization

`src/claudeArgs.ts` walks tokens in flag-position. `--flag=val` splits on the first `=` (lookup target = `--flag`, value preserved if allowed). For short forms, `-x` and `-xval` (inline value) are normalized via the short→long map for `-n`/`-r`/`-p`/`-c`/`-v`/`-h`/`-w`. A small value-taking-flag table (sourced from `claude --help`) tells the walker when to skip the next token as a value rather than re-classify it as a flag — covers both denied (`-n`, `--add-dir`, `--mcp-config`, …) and allowed (`--model`, `--agent`, `--agents`, `--permission-mode`, …) value-takers, so JSON values containing `--` substrings (e.g. `--agents '{"foo": "--not-a-flag"}'`) don't trigger spurious denials.

**Unknown flags default to "no value."** Conservative: false-positives on a denied-adjacent flag error visibly (the user discovers a missing entry in the value-taking table); the alternative would mask denied tokens by treating them as values. `--add-dir` after `--unknown-new-flag` errors on `--add-dir` (correct outcome — extend the value-taking table when a real new value-taking flag lands).

### Forward compatibility

If a future Claude Code flag needs to join the denylist (e.g. a new host-path flag), that is an additive ccairgap change — bump the denylist in `src/claudeArgs.ts` and the table above. Until then, new flags work the day they ship.

## Hook policy

Claude Code hooks run arbitrary host commands in response to tool calls and session events (`PreToolUse`, `PostToolUse`, `SessionStart`, `Notification`, `UserPromptSubmit`, `Stop`, `PermissionRequest`). Host-side hook configs routinely reference binaries (`afplay`, project-local `python3` scripts, user-installed CLIs) that are not present in the sandboxed container; left unfiltered, they fail on every tool call and break the session.

**Default: all hooks disabled, statusLine preserved.** The CLI sets `disableAllHooks: false` and overlays an empty `hooks: {}` field at every hook-bearing source (user settings, every enabled plugin's `hooks.json`, project settings). No hook command is executed. `statusLine` survives — Claude Code's `disableAllHooks: true` flag would also kill the custom status line, so this default explicitly avoids it. Trade-off: any future hook source ccairgap doesn't enumerate would slip through; keep `enumerateHooks` and `applyHookPolicy` in lockstep.

**Opt-in: `--hook-enable <glob>` (repeatable) or `hooks.enable: [<glob>, …]` in config.** Each glob is matched against the raw `command` string of each hook entry. Wildcard is `*` (anchored full match). Hooks whose command matches any glob are kept; everything else is stripped. Glob semantics are deliberately thin — users see the exact `command` strings in their JSON, so a substring-with-`*` match is sufficient to describe intent.

### Mechanism

Claude Code has **no native per-hook disable**; the only global switches are `disableAllHooks: true` (suppresses every hook **and** the custom `statusLine`) and `enabledPlugins[<key>] = false` (disables an entire plugin, which also loses its skills/commands/agents — too coarse for per-hook opt-in). The `disableAllHooks` flag is unusable as ccairgap's default because it kills `statusLine`, so instead the CLI rewrites hook-bearing JSON host-side at every source and overlays the patched copies in the container via nested single-file bind mounts. The same overlay path runs whether the enable list is empty (filtered = `{}`, neutralizing every hook) or non-empty (filtered down to surviving entries).

- **User settings:** host `~/.claude/settings.json` is read, its `hooks` field is filtered, and `disableAllHooks: false` is forced (overrides any host-level setting and keeps `statusLine` running). The patched file is written to `$SESSION/hook-policy/user-settings.json` and mounted RO at `/host-claude-patched-settings.json`. The entrypoint `cp`s it over the rsync'd `settings.json` before the env-merge step.
- **Plugin hooks (cache-backed):** for each `enabledPlugins[<plugin>@<market>] === true` whose cache dir has a `hooks/hooks.json`, the `hooks` field is filtered, the patched file written to `$SESSION/hook-policy/plugins/<market>/<plugin>/<ver>/hooks.json`, and mounted RO over `/home/claude/.claude/plugins/cache/<market>/<plugin>/<ver>/hooks/hooks.json`. The outer plugin-cache RO mount is declared first; the inner file mount lands later and overlays the parent. Always runs.
- **Plugin hooks (directory-sourced):** marketplaces with `source.source === "directory"` are loaded by Claude Code from the marketplace source tree, not from the cache. Each such marketplace's `.claude-plugin/marketplace.json` is parsed; for every `plugins[]` entry whose `<plugin>@<market>` is enabled, `<pluginDir>/hooks/hooks.json` is filtered, written to `$SESSION/hook-policy/dir-plugins/<market>/<plugin>/hooks.json`, and mounted RO over the host path `<pluginDir>/hooks/hooks.json` (same path inside the container, since `discoverLocalMarketplaces` RO-mounts the source tree 1:1). Without this, hooks in directory-sourced plugins bypass the cache overlay and fire unfiltered. Always runs.
- **Project settings:** for each repo (`--repo` + every `--extra-repo`), both `.claude/settings.json` and `.claude/settings.local.json` in the session clone are read, filtered, and overlaid via a single-file bind mount at the repo's container path. The session clone on disk is not modified — the overlay leaves `git status` clean. Always runs.

Host files are never mutated; all patched copies live under `$SESSION/hook-policy/` and die with the session dir.

### Scope and limitations

- **Identification is by `command` string alone.** No type/matcher/event-based targeting. Users who want to enable "all `python3` hooks but only in PreToolUse" should either encode intent in the command (common) or accept that `python3 *` keeps them all.
- **No probing.** The CLI does not introspect the container image to decide which commands would work. Enabling a hook whose command is missing still fails at hook invocation; users who extend the Dockerfile are trusted to match their enable list to their image.
- **Matcher and event structure is preserved.** Only inner hook entries are dropped; matcher groups and event arrays that become empty are then pruned to avoid `hooks: { PreToolUse: [] }` fragments.
- **MCP hook sources** are not a distinct class in Claude Code's config — hooks live in user settings, project settings, or plugin `hooks.json`. Any MCP that registers hooks does so through one of those surfaces, all of which are covered.
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

**Default: all MCP servers disabled.** The CLI overlays `mcpServers: {}` at every MCP-bearing source (user `~/.claude.json` top-level, user-project `~/.claude.json` `projects[*].mcpServers`, project `<repo>/.mcp.json`, enabled plugin `.mcp.json` / `plugin.json#mcpServers`). No server starts.

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
- **Plugin `.mcp.json` / `plugin.json` (cache-backed):** for each `enabledPlugins[<plugin>@<market>] === true`, each file that exists under `~/.claude/plugins/cache/<market>/<plugin>/<ver>/` is filtered, written to `$SESSION/mcp-policy/plugins/<market>/<plugin>/<ver>/<fname>`, and mounted RO over the same path inside the container's plugin cache.
- **Plugin `.mcp.json` / `plugin.json` (directory-sourced):** marketplaces with `source.source === "directory"` are loaded from the marketplace source tree (RO-mounted 1:1 by `discoverLocalMarketplaces`). For each enabled plugin the CLI filters `<pluginDir>/.mcp.json` and `<pluginDir>/plugin.json`, writes to `$SESSION/mcp-policy/dir-plugins/<market>/<plugin>/<fname>`, and mounts RO over the host path.
- **Project `<repo>/.mcp.json`:** for each repo (`--repo` + every `--extra-repo`), if the session clone has `.mcp.json` it is filtered by glob AND approval state, written to `$SESSION/mcp-policy/projects/<repo>/.mcp.json`, and mounted RO at the repo's container path. Approval is derived from the host paths (user settings, `<repo>/.claude/settings.json[.local]`, `~/.claude.json` `projects[<abs>]`) — same scopes as `enumerateMcpServers`, so what `ccairgap inspect` shows as `approved` is exactly what survives the filter.

Host files are never mutated; all patched copies live under `$SESSION/mcp-policy/` and die with the session dir.

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

## Plugins, skills, commands, CLAUDE.md

**Host config copy-in:**
- Entrypoint `rsync -rL` from `/host-claude` into container `~/.claude/`. `-L` materializes host symlinks as plain files/dirs in container RW.
- Applies to: `settings.json`, `CLAUDE.md`, `statusline.sh`, `plugins/` (minus `cache/`), `skills/`, `commands/`, anything else in `~/.claude/` except session-specific dirs (`projects/`, `sessions/`, `todos/`, `shell-snapshots/`, `history.jsonl`), `plugins/cache/` (RO-mounted separately), and `.credentials.json` (handled via `/host-claude-creds`).

**Project-scope working-tree overlay:**
- After `git clone --shared` + `git checkout -b ccairgap/<id>`, the CLI `rsync -rL`s three host-working-tree paths into each session clone (per `--repo` / `--extra-repo`):
  - `<hostPath>/.claude/`  → `<clonePath>/.claude/` (merge; host files overwrite clone files on conflict)
  - `<hostPath>/.mcp.json` → `<clonePath>/.mcp.json`
  - `<hostPath>/CLAUDE.md` → `<clonePath>/CLAUDE.md`
- Rationale: `git clone --shared` checks out HEAD, so uncommitted / `.gitignore`'d project-scope config is invisible to the container. Notably, `.claude/settings.local.json` is gitignored by Claude Code convention and carries MCP approvals + permission allow-lists; without the overlay every session starts with those reset.
- Symlink handling: `rsync -L` follows symlinks and materializes targets as real files. Handles the common `CLAUDE.md → AGENTS.md` swap and out-of-repo skill targets uniformly — the container only ever sees real files.
- Scope is closed and minimal: these three paths only. Other repo-root paths (e.g. `.env.local`, generated configs) are out of scope — use `--cp` / `--sync` as today.
- Interaction with `dirtyTree`: these three paths are excluded from the exit-time scan via pathspec (`:(exclude).claude :(exclude).mcp.json :(exclude)CLAUDE.md`), so overlay-introduced "uncommitted" state doesn't trigger preservation. Consequence: container-side edits to any of these paths are also lost on exit (by design — sandbox shouldn't mutate Claude config across sessions).
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

Entrypoint ends with `exec claude --dangerously-skip-permissions`.

- `ccairgap` drops directly into Claude's REPL.
- For walk-away use, user wraps in tmux on the host: `tmux new -s work 'ccairgap ...'`.
- No in-container tmux; the Dockerfile does not install it.

## Network

- Default Docker bridge network. Full outbound.
- Capabilities: `--cap-drop=ALL` (no Linux capabilities granted). Container runs as a non-root user, needs no capabilities for normal Claude / git / node operation. Prevents raw sockets, ARP spoofing, firewall manipulation, chown, and everything else — does not block HTTP/HTTPS exfiltration (which is the accepted risk).
- `--security-opt=no-new-privileges`: blocks setuid/setgid binaries and file capabilities from granting additional privileges inside the container. Defense-in-depth against a local-priv-esc primitive chained with any cap regression.

## Environment variables

**Inside the container** — set via `~/.claude/settings.json` `env` block:

- `DISABLE_AUTOUPDATER=1`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
- `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`

Also injected at the top level of the same file: `skipDangerousModePermissionPrompt: true` — suppresses Claude Code's one-time "Bypass Permissions mode" startup warning. Container is already sandboxed, so the prompt is redundant and would block non-interactive `-p` runs. Host settings unaffected (container settings.json is rsync'd from host then patched in-place; writes never leak back).

These persist across `/clear` and any session restart inside the container.

No `CLAUDE_CODE_OAUTH_TOKEN` env var is used; auth comes from the host's `~/.claude/.credentials.json` via the RO mount.

**Passed from host to container** — set by the CLI on `docker run`:

| Env var | Source | Purpose |
|---------|--------|---------|
| `CCAIRGAP_CWD` | `--repo[0]` (or `/workspace`) | Container cwd for `cd` in entrypoint. |
| `CCAIRGAP_TRUSTED_CWDS` | All repo paths | Trust-dialog bypass in `.claude.json`. |
| `CCAIRGAP_PRINT` | `--print` | Non-interactive prompt. |
| `CCAIRGAP_NAME` | session id | Always set. Carries `<prefix>-<4hex>` from the CLI. Entrypoint uses it for `-n "ccairgap $CCAIRGAP_NAME"` (label) and the UserPromptSubmit rename hook emits `[ccairgap] $CCAIRGAP_NAME`. Resume flows use the same slug — the prior session's display name is not preserved. |
| `CCAIRGAP_RESUME` | `--resume <uuid>` | Set when `--resume` is passed. Entrypoint appends `-r "$CCAIRGAP_RESUME"` to the claude exec. |
| `CCAIRGAP_GIT_USER_NAME` | `git config --get user.name` (run in `--repo[0]`) | Set as `git config --global user.name` in entrypoint. Fallback `ccairgap` if host has none. |
| `CCAIRGAP_GIT_USER_EMAIL` | `git config --get user.email` (run in `--repo[0]`) | Set as `git config --global user.email` in entrypoint. Fallback `noreply@ccairgap.local` if host has none. |
| `COLORTERM` | hardcoded `truecolor` | Enables 24-bit color output in the container terminal. |
| `TZ` | `Intl.DateTimeFormat().resolvedOptions().timeZone` (host IANA zone) | Container timezone matches the host. Resolved via the image's `tzdata` package. Omitted if the host runtime has no IANA zone. |
| `CCAIRGAP_CLIPBOARD_MODE` | `host-bridge` | Set when clipboard passthrough is active. Triggers entrypoint shim install + xclip-regression warning. |

**On the host** — read by the CLI:

| Env var | Effect |
|---------|--------|
| `CCAIRGAP_HOME` | Overrides the state dir. Default: `$XDG_STATE_HOME/ccairgap/` (which itself defaults to `~/.local/state/ccairgap/`). If set, this path replaces the default root wholesale — both `sessions/` and `output/` live underneath. |
| `CCAIRGAP_CC_VERSION` | Short-form override for `--docker-build-arg CLAUDE_CODE_VERSION=<value>`. Used at image build time. |

Other XDG env vars (`XDG_STATE_HOME`, etc.) are respected per the XDG Base Directory spec.

## Handoff routine

Used by both the exit trap and `ccairgap recover`. Takes a `$SESSION/<id>/` dir as input. Must be idempotent — safe to run multiple times on the same dir.

1. Read `$SESSION/<id>/manifest.json`. Check the top-level `"version"` field; if it is unknown to the current CLI, abort with a clear message (`"manifest v<N> requires ccairgap ≥ <X.Y.Z>"`). Otherwise extract the repo→host-path mapping.
2. For each entry in the manifest:
   - Rewrite the session clone's `.git/objects/info/alternates` back to `<real-host-path>/.git/objects/` so host `git` can traverse history (the container-side path `/host-git-alternates/...` is meaningless on the host).
   - Count commits on `ccairgap/<id>` not reachable from any `origin/*` ref in the session clone: `git -C <session-clone> rev-list --count ccairgap/<id> --not --remotes=origin`.
     - If the count is 0, **skip the fetch** — the sandbox branch has no new work, and creating an empty ref on the host would be noise. Record the repo as `empty`.
     - If the count is > 0, run `git -C <real-host-path> fetch $SESSION/<id>/repos/<alternates_name> ccairgap/<id>:ccairgap/<id>` (where `<alternates_name>` is the manifest field — falling back to `<basename>` for manifests written by older CLI builds). `git fetch` with an explicit ref is idempotent — running it a second time with the branch already present is a no-op.
   - If fetch fails (branch doesn't exist, host path gone), log and continue — not fatal.
3. For each entry in the manifest's `sync` list (absent in old manifests — treat as empty): rsync `session_src/` → `$CCAIRGAP_HOME/output/<id>/<src_host>/`. `rsync -a` for directories, `cp -a` for files. Missing `session_src` logs and continues — not fatal. Idempotent (safe to re-run).
4. For each `<path-encoded-cwd>` dir in `$SESSION/<id>/transcripts/`:
   - Recursively copy its contents into `~/.claude/projects/<same-dir-name>/` on host (`cp -r` or `rsync -a`, merging with any existing content — session UUIDs make nested dirs unique).
   - This preserves the `<session-uuid>/*.jsonl` and `<session-uuid>/subagents/*.jsonl` structure.
   - Create target dir if missing.
5. **Preserve session dir** (skip step 6) if **any** of the following holds for **any** repo in the manifest:
   - The session clone's working tree is dirty (`git status --porcelain` non-empty, `.gitignore` respected, plus pathspec excludes `:(exclude).claude :(exclude).mcp.json :(exclude)CLAUDE.md` — see §"Project-scope working-tree overlay"). The scan runs after step 2's alternates rewrite — ordering must be preserved. When the caller passes `--no-preserve-dirty` / config `no-preserve-dirty: true`, the scan still runs but a dirty result no longer triggers preservation (the scan stays on so scan-failure can still fire, see next bullet).
   - The dirty-tree scan failed (uncertainty → err on preserve). Fires regardless of `--no-preserve-dirty`.
   - The sandbox branch is empty **and** another local branch carries commits not reachable from `origin/*`. Fires regardless of `--no-preserve-dirty`.

   The warning emitted names every preservation trigger (dirty repos with their modified/untracked counts, scan-failed repos with their git error, orphan branches with their commit counts) and tells the user the exact `cd` path and `ccairgap recover <id>` next step. `ccairgap discard <id>` is offered as an exit only when safe — suppressed when orphan-branch commits would be lost.

   Known limitation: edits to files matched by `.gitignore` (e.g. `.env.local`) are not detected and are lost on exit. Workaround: launch with `--sync <path>`.
6. `rm -rf $SESSION/<id>` unless step 5 preserved it.

Failure at any step does not cause the routine to skip subsequent steps. Goal is best-effort preservation of work.

## Exit trap

On container exit (any reason — normal, error, signal), the CLI runs the handoff routine against the current session's `$SESSION/<id>/`.

Exit trap is **not** guaranteed to fire. If `ccairgap` itself is SIGKILLed (OOM, `kill -9`, tmux pane force-close, laptop crash, host reboot), the session dir is left intact on disk and no handoff happens. Use `ccairgap recover <id>` to finish it manually.

**Resume hint.** After the container exits, before handoff runs, the CLI scans `$SESSION/transcripts/<encoded-workspace-cwd>/*.jsonl`, picks the newest by mtime, reads its last `customTitle` (head+tail 64 KiB scan — see §"--resume"), and emits a stderr hint:

```
ccairgap: resume this session with:
  ccairgap --resume <uuid>    # <custom-title>
  ccairgap --resume '<custom-title>'
```

The UUID is the one Claude Code picked (not the ccairgap `<id>`), so this is the only place a user can reliably learn it post-hoc. The title line is omitted when no `customTitle` is present. Best-effort; any read error silently suppresses the hint.

## Recovery

`ccairgap list` — list orphaned sessions:
- Scan `$XDG_STATE_HOME/ccairgap/sessions/` (or `$CCAIRGAP_HOME/sessions/` if overridden).
- For each entry: if a container named `ccairgap-<id>` is currently running (`docker ps`), skip (live session in another terminal). Otherwise classify as orphan.
- Print timestamp, repos involved (from manifest), and commit counts on `ccairgap/<id>` in each session clone.

`ccairgap recover [<id>]` — with `<id>`, run the handoff routine against `$SESSION/<id>/` (idempotent; safe to re-run). Without `<id>`, equivalent to `list`.

If the session contains a dirty working tree or orphan-branch commits, `recover` does not delete the session dir — it re-emits the same preservation warning. Commit or discard the work in the session clone (paths printed in the warning), then re-run `ccairgap recover <id>` to finalize.

`recover <id>` refuses to run against a session whose container is still running (checked via `docker ps --filter name=^/ccairgap-<id>$`). Stop the container with `docker stop ccairgap-<id>` first, or let it exit normally — the exit trap will run handoff.

`ccairgap discard <id>` — `rm -rf $SESSION/<id>/` without running handoff. Use when you don't want the sandbox branch in your real repo.

On every normal `ccairgap` startup, orphaned sessions are detected and a warning banner is printed with the suggested `recover` / `discard` commands. They are not auto-recovered.

### Manifest fields

`$SESSION/manifest.json` carries a top-level `"version": 1` field plus a `repos` array with one entry per cloned repo. Fields consumed by the handoff routine, `recover`, and orphan-scan include:

- `repos[].basename` (string, required): the raw basename of the host repo path.
- `repos[].host_path` (string, required): the absolute host path of the real repo.
- `repos[].alternates_name` (string, optional, additive v1): unique per-repo scratch segment `<basename>-<sha256(host_path)[:8]>`. Handoff/recover/orphan-scan use this to locate `$SESSION/repos/<alternates_name>` on disk. Omitted in sessions written by older CLI builds; consumers MUST fall back to `basename` when absent.

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
- Network allowlisting via proxy — not needed under current threat model.
