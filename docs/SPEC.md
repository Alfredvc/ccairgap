# claude-airlock — Spec

Run `claude --dangerously-skip-permissions` in a Docker container so you can hand it a task and walk away. Exfiltration is an accepted risk; host state destruction is not.

## Goal

- Full-permission Claude Code inside a container.
- Host filesystem physically unable to be destroyed or mutated outside a small set of explicitly writable paths.
- Container work product (branches, transcripts) reachable on the host after session ends, without requiring the container to have write access to host state during the session.
- Behavior parity with host Claude: same plugins, skills, slash commands, global CLAUDE.md, settings, MCP configuration.

## Threat model

- **Accepted:** full exfiltration. Anything the container can read may be sent over the network.
- **Not accepted:** any write to host filesystem outside the small set of explicitly writable paths listed in §"Host writable paths". Specifically: real git repositories, host `~/.claude/`, host `~/.claude.json`, and anything else on disk must survive the session byte-for-byte.
- **Container escape:** not part of the threat model, but we avoid flags that lower the default Docker isolation (no `--privileged`, no `SYS_ADMIN`, no `docker.sock` mount).

## Implementation

- **Language:** TypeScript, compiled to a single bundled JS file with [tsup](https://tsup.egoist.dev/).
- **Runtime:** Node.js ≥ 20 on the host. The container uses its own Node 20 base image independently.
- **Distribution:** npm package `claude-airlock`. Primary install path is `npm i -g claude-airlock`; `npx claude-airlock …` works for one-shot use.
- **Package layout:**
  - `dist/cli.js` — bundled entry, declared in `package.json` `bin`.
  - `docker/Dockerfile` — shipped as a package asset; copied out or read by the CLI at build time.
  - `docker/entrypoint.sh` — runs inside the container; stays in bash (fixed Alpine-ish environment, no portability concerns).
- **Dependencies kept lean:** `commander` for arg parsing, `execa` for shelling out to `docker` / `git`. No runtime dep on external config libraries.
- **License:** MIT.
- **Repository:** `github.com/alfredvc/claude-airlock`.

## Versioning

- **CLI:** semver. Patch = bug fixes, minor = new flags / new optional manifest fields, major = flag rename or removal, manifest shape change, or state-dir layout change.
- **Container image tag** = CLI version (or `custom-<hash>` when built from a user Dockerfile). See §"Container image".
- **Claude Code inside the image:** defaults to `@latest` at build time. Same CLI version can therefore produce images with different Claude Code versions over time. Users who want reproducibility pin via `--docker-build-arg CLAUDE_CODE_VERSION=<semver>` or `CLAUDE_AIRLOCK_CC_VERSION=<semver>`.
- **Manifest schema:** `$SESSION/manifest.json` carries a top-level `"version": <N>` field. The handoff routine reads it first and errors clearly on unknown versions. Bump only when the shape changes incompatibly.
- **Flag stability:** launch-command flags and subcommand names are part of the public API. Renaming or removing either requires a major version bump.

## Host storage layout

All paths follow XDG Base Directory convention.

```
${XDG_STATE_HOME:-$HOME/.local/state}/claude-airlock/
├── sessions/
│   └── <ts>/                      # per-session state, ephemeral
│       ├── repos/
│       │   └── <repo-name>/       # git clone --shared of host repo
│       ├── transcripts/           # bind-mounted at container ~/.claude/projects/
│       └── (other per-session scratch)
└── output/                        # single reused dir, bind-mounted at /output
```

- `<ts>` is ISO 8601 compact, e.g. `20260417T143022Z`.
- Host `~/.claude/` is the source of credentials, settings, plugins, skills, commands, CLAUDE.md. It is RO-mounted into the container; there is no separate profile volume.

## Host writable paths (the only ones)

A session may cause writes to:

1. `$XDG_STATE_HOME/claude-airlock/sessions/<ts>/` — session scratch, created fresh, deleted on exit after transcripts copy. Includes `$SESSION/creds/.credentials.json` on macOS (see §"Authentication flow").
2. `$XDG_STATE_HOME/claude-airlock/output/` — `/output` mount inside container.
3. `~/.claude/projects/<path-encoded-cwd>/` — transcript copy-back on exit.
4. Real host repos passed to `--repo` and `--extra-repo`: **only** the ref `sandbox/<ts>` is created via `git fetch` on exit. No other mutations. `.git/objects` is RO-mounted into the container.

No other host path is writable by the container. `~/.claude/`, `~/.claude.json`, plugin marketplace repos, `--ro` reference paths are all RO-mounted.

## Command line interface

```
claude-airlock [SUBCOMMAND] [OPTIONS]
```

Default (no subcommand): start a new session.

**Launch flags** (apply to the default `claude-airlock` invocation):

| Flag | Repeatable | Description |
|------|------------|-------------|
| `--repo <host-path>` | no | Host repo exposed as the workspace (container cwd). Cloned with `--shared`, new branch `sandbox/<ts>` created. If omitted, defaults to the current working directory (must be a git repo). |
| `--extra-repo <host-path>` | yes | Additional host repo mounted alongside `--repo`. Same `--shared` clone + `sandbox/<ts>` branch, but not the workspace. Use for sibling repos Claude reads but does not work in as its primary target. |
| `--ro <host-path>` | yes | Additional read-only bind mount. Path can be anything — a git repo, a docs dir, any reference material. `--ro` never creates a sandbox branch; Claude gets read-only visibility. |
| `--base <ref>` | no | Base ref for `sandbox/<ts>` branch. Default: current HEAD of each repo (`--repo` + every `--extra-repo`). |
| `--keep-container` | no | Omit `docker run --rm`. Container persists after exit for postmortem via `docker logs` / `docker exec`. Manual cleanup: `docker rm claude-airlock-<ts>`. |
| `--dockerfile <path>` | no | Build from a user-supplied Dockerfile instead of the bundled one. Resulting image tag carries a `custom-<hash>` suffix (see §"Container image"). |
| `--docker-build-arg KEY=VAL` | yes | Forwarded to `docker build --build-arg`. Common use: `CLAUDE_CODE_VERSION=1.2.3` to pin Claude Code. |
| `--rebuild` | no | Force rebuild of the container image before launching, even if the tag already exists locally. |
| `-p, --print <prompt>` | no | Run Claude Code in non-interactive print mode: `claude -p "<prompt>"` instead of the REPL. The container still runs with full permissions and all mounts; it just does a single prompt and exits. Useful for smoke tests and scripted runs. |

No `--auth` or `--profile` flags. Credentials are inherited from the host's `~/.claude/` via RO mount. If you are not logged in on the host, run `claude` on the host first.

**Subcommands:**

| Subcommand | Description |
|------------|-------------|
| `list` | List orphaned sessions (session dirs on disk with no running container). Prints timestamp, repos involved, and commit counts on `sandbox/<ts>`. |
| `recover [<ts>]` | Run the handoff routine against `$SESSION/<ts>/`. Idempotent. With no `<ts>` argument, equivalent to `list`. |
| `discard <ts>` | Delete `$SESSION/<ts>/` without running handoff. Use when you don't want the sandbox branch in your real repo. |
| `doctor` | Preflight checks (Docker running, host credentials present, state dir writable, image present/stale). |

**Examples:**

```bash
# Interactive session: workspace repo + sibling repo + reference dir
claude-airlock \
  --repo ~/src/foo \
  --extra-repo ~/src/bar \
  --ro ~/src/docs

# Walk-away (launch inside a host tmux)
tmux new -s work 'claude-airlock --repo ~/src/foo'

# Recover an orphaned session
claude-airlock list
claude-airlock recover 20260417T143022Z

# Force image rebuild with a pinned Claude Code version
claude-airlock --rebuild --docker-build-arg CLAUDE_CODE_VERSION=1.2.3 --repo ~/src/foo
```

## CLI responsibilities

In order:

1. Parse flags. Resolve `--repo` (single, workspace), `--extra-repo` (repeatable), `--ro` (repeatable), `--base`.
   - If `--repo` is unset and `$(pwd)` is a git repo, default `--repo` to `$(pwd)`.
   - If `--repo` is still unset and `--extra-repo` is non-empty, error: "--extra-repo requires --repo <path> (workspace)."
   - If `--repo` is still unset and `--ro` is non-empty, proceed with no session clone (Claude only gets RO views; no sandbox branch).
   - If `--repo` is still unset and `--ro` is empty, error: "not in a git repo and no --repo / --ro passed."
   - The full repo set is `[--repo, ...--extra-repo]` in that order; the workspace / container cwd is the first entry.
   - Error if the same resolved path appears in more than one of `--repo` / `--extra-repo` / `--ro`.
2. Subcommand dispatch: if the first positional is `list`, `recover`, `discard`, or `doctor`, run that handler per §Recovery / §Doctor and exit. Launch flags are only consumed by the default (no-subcommand) invocation.
3. Scan `$XDG_STATE_HOME/claude-airlock/sessions/` for orphaned session dirs (dirs without a running container named `claude-airlock-<ts>`, checked via `docker ps`). If any exist, print a warning banner listing them with suggested `claude-airlock recover <ts>` / `claude-airlock discard <ts>` commands. Do not auto-recover; continue to new session setup.
4. Resolve host credentials (see §"Authentication flow"):
   - macOS: run `security find-generic-password -w -s "Claude Code-credentials"`. If the command errors, print "run `claude` on the host to log in, then unlock the keychain" and exit. Otherwise write stdout to `$SESSION/creds/.credentials.json` with mode 0600.
   - Non-macOS: verify host `~/.claude/.credentials.json` exists. If missing, print "run `claude` on the host to log in" and exit.
5. Compute `<ts>`, create `$SESSION = $XDG_STATE_HOME/claude-airlock/sessions/<ts>/`.
6. For each repo in the set (`--repo` plus every `--extra-repo`):
   - `git clone --shared <path> $SESSION/repos/<basename>`
   - `cd $SESSION/repos/<basename> && git checkout -b sandbox/<ts> [<base>]`
7. Record a `$SESSION/manifest.json` capturing the repo→host-path mapping, so `claude-airlock recover` can reconstruct the fetch targets without re-parsing argv. The manifest **must** start with `"version": 1` (see §"Versioning"). Also record `cli_version`, `image_tag`, and (best-effort) the Claude Code versions on host and in the image for postmortem.
8. Create `$SESSION/transcripts/` and `$XDG_STATE_HOME/claude-airlock/output/` (idempotent).
9. Resolve symlinks (`readlink -f`) for all host paths being mounted: `~/.claude/`, `~/.claude.json`, `~/.claude/CLAUDE.md`, plugin marketplace paths, `--repo` / `--extra-repo` / `--ro` targets.
10. Auto-discover plugin marketplace paths referenced by host `~/.claude/settings.json` (absolute paths outside `~/.claude/`). Add each as a RO mount at its original absolute path.
11. Build `docker run` command:
    - `--rm` (omit if `--keep-container` was passed)
    - `--cap-drop=ALL`
    - `-it` (interactive)
    - `--name claude-airlock-<ts>`
    - Mount list per §"Container mount manifest"
    - Image: `claude-airlock:<cli-version>` by default, or `claude-airlock:custom-<sha256(dockerfile)[:12]>` if `--dockerfile` was passed. Build if the tag is missing locally, or if `--rebuild` was passed.
12. Install exit trap: run §"Handoff routine" against `$SESSION/<ts>/`.
13. Exec the `docker run` command.

## Container mount manifest

| Host source | Container path | Mode | Notes |
|-------------|----------------|------|-------|
| `~/.claude/` (resolved) | `/host-claude` | ro | Entrypoint rsyncs contents to `~/.claude/` (settings, plugins minus cache, skills, commands, CLAUDE.md, statusline). `.credentials.json` and `.DS_Store` are excluded from the copy — see the `/host-claude-creds` row for credentials. |
| `~/.claude.json` (resolved) | `/host-claude-json` | ro | Entrypoint copies to `~/.claude.json`, patches onboarding. |
| macOS: `$SESSION/creds/.credentials.json` / Linux: `~/.claude/.credentials.json` | `/host-claude-creds` | ro | Single-file mount. Entrypoint copies to `~/.claude/.credentials.json`, chmod 600. See §"Authentication flow". |
| `~/.claude/plugins/cache/` (resolved) | `/home/claude/.claude/plugins/cache/` | ro | RO-mount stays even after entrypoint copy so this big dir is not duplicated into container FS. |
| `$SESSION/transcripts/` | `/home/claude/.claude/projects/` | rw | Transcripts write target. |
| `$XDG_STATE_HOME/claude-airlock/output/` | `/output` | rw | Artifact drop. |
| `$SESSION/repos/<repo>/` | `<original-host-path>` | rw | Session clone. |
| `<resolved-git-dir>/objects/` | `/host-git-alternates/<basename>/objects/` | ro | Alternates target for `--shared` clone. The session clone's `.git/objects/info/alternates` is rewritten to this container path so new commits write to the session clone's own RW `objects/` while historical reads resolve through here. See §"Repository access mechanism". |
| `<resolved-git-dir>/lfs/objects/` | `/host-git-alternates/<basename>/lfs/objects/` | ro | LFS content. Session clone's `.git/lfs/objects/` is replaced with a symlink to this path. Mount is optional — skipped if source dir doesn't exist. |
| `<--ro path>` | `<original-host-path>` | ro | Reference material. |
| `<plugin-marketplace-path>` | `<original-host-path>` | ro | Auto-discovered from settings.json. |

Absolute paths are preserved between host and container so `settings.json` references resolve identically.

## Container image

**Distribution model:** the image is built locally on first use from a Dockerfile shipped inside the npm package. No registry pull. The user can substitute their own Dockerfile via `--dockerfile <path>`.

**Base:** `node:20-slim` (latest LTS).

**Installed:**
- `@anthropic-ai/claude-code` globally, version pinned via `ARG CLAUDE_CODE_VERSION=latest` (default tracks upstream; override via `--docker-build-arg CLAUDE_CODE_VERSION=<semver>`).
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
  --build-arg CLAUDE_CODE_VERSION=latest \
  -t claude-airlock:<cli-version> .
```

Dockerfile:
```dockerfile
ARG HOST_UID=1000
ARG HOST_GID=1000
ARG CLAUDE_CODE_VERSION=latest
RUN groupadd -g ${HOST_GID} claude \
 && useradd -m -u ${HOST_UID} -g ${HOST_GID} -s /bin/bash claude
RUN npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
```

Docker's layer cache handles rebuild on UID/GID change — the CLI always passes the args, Docker reuses layers when the values haven't changed.

**Image tagging scheme:**

| Invocation | Tag |
|------------|-----|
| Default | `claude-airlock:<cli-version>` |
| `--dockerfile <path>` | `claude-airlock:custom-<sha256(dockerfile)[:12]>` |

The hash suffix for custom Dockerfiles is deterministic: the same Dockerfile content always produces the same tag, so rebuilds are skipped when nothing changed. Custom and default tags coexist without collision.

**Rebuild triggers** (the CLI builds the image only if one of these applies):
1. No local image matches the computed tag.
2. `--rebuild` was passed.
3. `--dockerfile` was passed and its content hash differs from any existing `custom-*` tag.

Image age is never auto-rebuilt. `claude-airlock doctor` surfaces a warning if the image is older than a threshold (default: 14 days) so the user can explicitly `--rebuild`.

## Entrypoint

Runs at container start. Steps:

1. `mkdir -p /home/claude/.claude`
2. Copy `/host-claude/` → `/home/claude/.claude/` with `rsync -rL --chmod=u+w` (transform symlinks into files, ensure writable in destination). Exclude these session-local entries so we don't drag host state into the container's fresh session view: `projects/`, `sessions/`, `history.jsonl`, `todos/`, `shell-snapshots/`, `debug/`, `paste-cache/`, `session-env/`, `file-history/`. Also exclude `plugins/cache/` (RO-mounted separately at the same container path), `.credentials.json` (handled in the next step), and `.DS_Store` (macOS metadata at any depth — often has ACLs that break copies).
3. If `/host-claude-creds` exists, `cp -L /host-claude-creds /home/claude/.claude/.credentials.json` and `chmod 600` the destination.
4. Copy `/host-claude-json` → `/home/claude/.claude.json`.
5. Patch `/home/claude/.claude.json` via `jq` to ensure:
   - `hasCompletedOnboarding: true`
   - `projects.<cwd>.hasTrustDialogAccepted: true` for each session repo's cwd
6. Merge env-var overrides into `/home/claude/.claude/settings.json` (use `jq '.env = (.env // {}) + { ... }'` to preserve existing entries):
   ```json
   {
     "env": {
       "DISABLE_AUTOUPDATER": "1",
       "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
       "CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL": "1"
     }
   }
   ```
7. If no `--repo` was passed (ro-only session), cwd defaults to `/workspace` (simple fallback). Otherwise cwd = `--repo`'s preserved path (the workspace). `--extra-repo` entries are mounted at their preserved paths but never become cwd.
8. If `AIRLOCK_PRINT` env var is set: `exec claude --dangerously-skip-permissions -p "$AIRLOCK_PRINT"`. Otherwise: `exec claude --dangerously-skip-permissions` (interactive REPL).

## Authentication flow

Credentials come from the host's existing Claude Code login. Storage location differs per OS, so the CLI normalizes both paths to a single RO mount at `/host-claude-creds` inside the container; the entrypoint copies from there into `~/.claude/.credentials.json`.

- **macOS:** Claude Code stores credentials in the Keychain (item `Claude Code-credentials`). The CLI reads them at launch with `security find-generic-password -w -s "Claude Code-credentials"`, writes the JSON to `$SESSION/creds/.credentials.json` (mode 0600), and bind-mounts that file at `/host-claude-creds`. The materialized file is deleted with the session dir on exit. Keychain ACLs may prompt for approval on first read; grant "Always Allow" to avoid re-prompts.
- **Linux / other:** The CLI bind-mounts host `~/.claude/.credentials.json` directly at `/host-claude-creds`. No session-dir copy is needed.

The entrypoint does `cp -L /host-claude-creds ~/.claude/.credentials.json` and `chmod 600` on the destination. The container's copy is writable, so Claude Code can refresh the access token in-place during the session; the host keychain / credentials file stay untouched.

The `/host-claude` RO mount (the rest of `~/.claude/`) does not include `.credentials.json` — the credentials file is handled solely via `/host-claude-creds` to keep the code path uniform across macOS and Linux.

Behavior:

- Log in on the host once with `claude` (normal host login).
- `claude-airlock` inherits those credentials for the duration of the container.
- The container's `~/.claude/` is writable (normal home dir), so session mutations (permission cache, prompt history in `.claude.json`) stay in-container and die with it — host state is untouched.
- To switch accounts, log in differently on the host before launching. Multi-profile support is out of scope.

## Repository access mechanism

Uses `git clone --shared`: session clone stores only refs + new commits; existing objects resolved via `.git/objects/info/alternates` pointing at host repo's RO-mounted object dir.

**Alternates rewrite:**

`git clone --shared` writes an `alternates` file containing the host's real `.git/objects/` path. That path is not meaningful inside the container, and mounting the host's `objects/` at `<hostPath>/.git/objects/` would shadow the session clone's own (RW) `objects/` directory — blocking all new commits. Instead:

1. The host's `.git/objects/` is RO-mounted at a neutral container path: `/host-git-alternates/<basename>/objects/`.
2. The CLI rewrites the session clone's `.git/objects/info/alternates` (host-side, post-clone) to contain `/host-git-alternates/<basename>/objects`.
3. Inside the container, `<hostPath>/.git/objects/` is the session clone's own RW `objects/`. New commits write there; git resolves historical objects via the alternates file.

LFS gets the same pattern: host `lfs/objects/` at `/host-git-alternates/<basename>/lfs/objects/`, and the session clone's `.git/lfs/objects/` is replaced with a symlink to that path.

**Resolving the real git dir:**

For each repo in the set (`--repo` plus every `--extra-repo`), the CLI determines the real `.git/` location before setting up mounts:

1. If `<path>/.git` is a directory: real git dir is `<path>/.git/`.
2. If `<path>/.git` is a file (worktree): read it, extract the `gitdir:` line, follow to the main repo's `.git/worktrees/<name>/`. Walk up to the main repo's `.git/` dir (the parent of `worktrees/`). Real git dir is that main `.git/`.
3. Otherwise: error, not a git repo.

The resolved git dir's `objects/` subdir becomes the RO mount source. `--shared` clone handled automatically by git (it follows worktree pointers when resolving the source).

**LFS:**

If `<resolved-git-dir>/lfs/objects/` exists on the host, it is additionally RO-mounted at `<original-host-path>/.git/lfs/objects/` in the container. `git-lfs` binary is installed in the container. Checkout/smudge in the session clone resolves LFS content from the mount without network fetches.

If the dir doesn't exist (repo doesn't use LFS), the mount is skipped. Never fatal.

**Isolation:**
- Session clone is RW; host repo's git metadata is RO-mounted at a neutral container path (only `.git/objects/` and optionally `.git/lfs/objects/`; working tree and refs are not).
- Any attempt to write to those RO mounts fails at kernel level.
- Commits by the container go into the session clone's own `.git/objects/` (at `<hostPath>/.git/objects/` inside the container) — never touch host.

**Exit handoff:**
- On container exit, the CLI runs `git -C <real-host-path> fetch $SESSION/repos/<name> sandbox/<ts>:sandbox/<ts>`.
- This happens on the host, not in the container. Container never has write access to the real repo.
- Result: a new branch `sandbox/<ts>` in the host repo containing Claude's commits. Host user reviews / merges / discards.

**Host constraints during session:**
- Do not run `git gc --prune=now` or `git prune` on the real repo — would delete objects the session clone references via alternates.
- Routine operations (checkout, commit, push, fetch, rebase, reset, auto-gc) are safe. The session clone has its own refs; host ref movement doesn't affect it.

## Transcripts

- Claude writes session transcripts to `~/.claude/projects/<path-encoded-cwd>/` inside the container.
- `<path-encoded-cwd>` is the absolute cwd with `/` replaced by `-`. Example: cwd `/Users/alfredvc/src/foo` → dir `-Users-alfredvc-src-foo`. This is deterministic encoding, not a hash; same path always produces the same dir name.
- The directory contains `<session-uuid>/*.jsonl` plus nested `<session-uuid>/subagents/*.jsonl` for subagent transcripts.
- The `projects/` path is a bind mount of an empty-per-session host dir: `$SESSION/transcripts/`. Container sees only its own session's transcripts — no read, modify, or delete access to older ones.
- On container exit, the CLI's exit trap recursively copies each `$SESSION/transcripts/<path-encoded-cwd>/` into host `~/.claude/projects/<same-dir-name>/` using `cp -r` (or `rsync -a`). Merging with any existing host content is safe — session UUIDs in nested dir names are unique.
- Because container preserves host absolute paths for repo cwds, the encoded dir name matches between container and host — `claude --resume` on the host finds the transcript naturally.
- Session dir is deleted after successful copy.

## Plugins, skills, commands, CLAUDE.md

**Host config copy-in:**
- Entrypoint `rsync -rL` from `/host-claude` into container `~/.claude/`. `-L` materializes host symlinks as plain files/dirs in container RW.
- Applies to: `settings.json`, `CLAUDE.md`, `statusline.sh`, `plugins/` (minus `cache/`), `skills/`, `commands/`, anything else in `~/.claude/` except session-specific dirs (`projects/`, `sessions/`, `todos/`, `shell-snapshots/`, `history.jsonl`), `plugins/cache/` (RO-mounted separately), and `.credentials.json` (handled via `/host-claude-creds`).

**Plugin marketplace discovery:**
- The CLI extracts absolute paths from `extraKnownMarketplaces` entries in host `~/.claude/settings.json` whose `source.source` is `"directory"` or `"file"`. These reference plugin marketplaces living outside `~/.claude/` (e.g. `~/src/agentfiles`, `~/src/claude-meta`).
- `github`/`git`/`npm`/`url` marketplaces resolve via the RO-mounted `~/.claude/plugins/cache/` — no extra mount needed.
- Each extracted path is RO bind-mounted at its original absolute path so `settings.json` references resolve inside the container.

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
- `~/.claude.json` `mcpServers` block is copied as-is into container.
- MCPs requiring binaries not present in container (e.g. `docker` for the grafana MCP) fail silently at startup.
- Users who want specific MCPs to work extend the Dockerfile with their own `RUN apt-get install ...` or equivalent.

**Plugin install during session:**
- `~/.claude/plugins/cache/` is RO-mounted.
- `/plugin install`, `/plugin marketplace update`, etc. error out because they can't write to cache.
- Intentional: no session-local plugin install. If a plugin is needed, it belongs in the Dockerfile.

## Run mode

Entrypoint ends with `exec claude --dangerously-skip-permissions`.

- `claude-airlock` drops directly into Claude's REPL.
- For walk-away use, user wraps in tmux on the host: `tmux new -s work 'claude-airlock ...'`.
- No in-container tmux; the Dockerfile does not install it.

## Network

- Default Docker bridge network. Full outbound.
- Capabilities: `--cap-drop=ALL` (no Linux capabilities granted). Container runs as a non-root user, needs no capabilities for normal Claude / git / node operation. Prevents raw sockets, ARP spoofing, firewall manipulation, chown, and everything else — does not block HTTP/HTTPS exfiltration (which is the accepted risk).

## Environment variables

**Inside the container** — set via `~/.claude/settings.json` `env` block:

- `DISABLE_AUTOUPDATER=1`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`
- `CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL=1`

These persist across `/clear` and any session restart inside the container.

No `CLAUDE_CODE_OAUTH_TOKEN` env var is used; auth comes from the host's `~/.claude/.credentials.json` via the RO mount.

**On the host** — read by the CLI:

| Env var | Effect |
|---------|--------|
| `CLAUDE_AIRLOCK_HOME` | Overrides the state dir. Default: `$XDG_STATE_HOME/claude-airlock/` (which itself defaults to `~/.local/state/claude-airlock/`). If set, this path replaces the default root wholesale — both `sessions/` and `output/` live underneath. |
| `CLAUDE_AIRLOCK_CC_VERSION` | Short-form override for `--docker-build-arg CLAUDE_CODE_VERSION=<value>`. Used at image build time. |

Other XDG env vars (`XDG_STATE_HOME`, etc.) are respected per the XDG Base Directory spec.

## Handoff routine

Used by both the exit trap and `claude-airlock recover`. Takes a `$SESSION/<ts>/` dir as input. Must be idempotent — safe to run multiple times on the same dir.

1. Read `$SESSION/<ts>/manifest.json`. Check the top-level `"version"` field; if it is unknown to the current CLI, abort with a clear message (`"manifest v<N> requires claude-airlock ≥ <X.Y.Z>"`). Otherwise extract the repo→host-path mapping.
2. For each entry in the manifest:
   - `git -C <real-host-path> fetch $SESSION/<ts>/repos/<basename> sandbox/<ts>:sandbox/<ts>`
   - `git fetch` with an explicit ref is idempotent — running it a second time with the branch already present is a no-op.
   - If fetch fails (no commits, branch doesn't exist, host path gone), log and continue — not fatal.
3. For each `<path-encoded-cwd>` dir in `$SESSION/<ts>/transcripts/`:
   - Recursively copy its contents into `~/.claude/projects/<same-dir-name>/` on host (`cp -r` or `rsync -a`, merging with any existing content — session UUIDs make nested dirs unique).
   - This preserves the `<session-uuid>/*.jsonl` and `<session-uuid>/subagents/*.jsonl` structure.
   - Create target dir if missing.
4. `rm -rf $SESSION/<ts>`

Failure at any step does not cause the routine to skip subsequent steps. Goal is best-effort preservation of work.

## Exit trap

On container exit (any reason — normal, error, signal), the CLI runs the handoff routine against the current session's `$SESSION/<ts>/`.

Exit trap is **not** guaranteed to fire. If `claude-airlock` itself is SIGKILLed (OOM, `kill -9`, tmux pane force-close, laptop crash, host reboot), the session dir is left intact on disk and no handoff happens. Use `claude-airlock recover <ts>` to finish it manually.

## Recovery

`claude-airlock list` — list orphaned sessions:
- Scan `$XDG_STATE_HOME/claude-airlock/sessions/` (or `$CLAUDE_AIRLOCK_HOME/sessions/` if overridden).
- For each entry: if a container named `claude-airlock-<ts>` is currently running (`docker ps`), skip (live session in another terminal). Otherwise classify as orphan.
- Print timestamp, repos involved (from manifest), and commit counts on `sandbox/<ts>` in each session clone.

`claude-airlock recover [<ts>]` — with `<ts>`, run the handoff routine against `$SESSION/<ts>/` (idempotent; safe to re-run). Without `<ts>`, equivalent to `list`.

`claude-airlock discard <ts>` — `rm -rf $SESSION/<ts>/` without running handoff. Use when you don't want the sandbox branch in your real repo.

On every normal `claude-airlock` startup, orphaned sessions are detected and a warning banner is printed with the suggested `recover` / `discard` commands. They are not auto-recovered.

## Known constraints

- **No `git gc --prune=now` on host during session.** The session clone references host objects via alternates; pruning host breaks the session.
- **Submodules not supported.** `.gitmodules` is copied into the session clone but submodule `.git/` dirs are not RO-mounted. `git submodule update --init` inside the container falls back to fetching from each submodule's remote URL (works for public submodules, fails for private). Work inside the container proceeds without initialized submodules.
- **macOS only tested.** Linux should work; Windows / WSL2 may need path adjustments.
- **Docker required.** No Podman-specific handling.
- **Single concurrent session per host recommended.** Multiple simultaneous sessions work but share `$XDG_STATE_HOME/claude-airlock/output/`. Sessions don't overlap on `<ts>` so repo clones are fine.
- **MCP servers that require host resources (docker.sock, local sockets, host binaries) will not work** unless the user extends the Dockerfile. Intentional.

## Out of scope

- Automatic extraction of Claude's output beyond git branches (bundles, patch files) — user can ask Claude to drop artifacts in `/output` manually.
- Per-MCP allowlisting — user customizes the Dockerfile.
- Network allowlisting via proxy — not needed under current threat model.
