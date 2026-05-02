# Config file

Any launch flag can live in a YAML file. Default load path: `<git-root>/.ccairgap/config.yaml`, with `<git-root>/.config/ccairgap/config.yaml` as a fallback (loaded only when the primary is absent; if both exist, ccairgap prints a warning to stderr and uses the primary). Override with `--config <path>` or `--profile <name>`.

Precedence: **CLI > project config > user-wide config (`config.yaml` > `integrations/`) > built-in defaults.** Scalars: CLI wins. Arrays (`extra-repo`, `ro`, `cp`, `sync`, `mount`, `docker-run-arg`, `hooks.enable`, `mcp.enable`, `claude-args`): concat, config first, CLI appended (no dedup). Maps (`docker-build-arg`): per-key merge, CLI wins.

Both kebab-case (matches CLI flag names) and camelCase keys are accepted — kebab is preferred because it mirrors the flags. Unknown keys or wrong types abort launch with a clear error. The CLI validator in `src/config.ts` is source of truth; this page mirrors it.

## Key reference

| YAML key | Type | Equivalent flag | Notes |
|----------|------|-----------------|-------|
| `repo` | string | `--repo` | Workspace repo. Single path. **Optional** — defaults to the git root containing the config. Relative → resolved against the **workspace anchor**. |
| `extra-repo` | `[string]` | `--extra-repo` (repeat) | Additional repos mounted + cloned. Same anchor as `repo`. Not the workspace. |
| `ro` | `[string]` | `--ro` (repeat) | RO bind mounts. Any path. Same anchor as `repo`. |
| `cp` | `[string]` | `--cp` (repeat) | Copy-in-discard. Relative → resolved against the **workspace repo root** at launch. |
| `sync` | `[string]` | `--sync` (repeat) | Copy-in, copy-out-on-exit to `$CCAIRGAP_HOME/output/<id>/`. Same anchor as `cp`. |
| `mount` | `[string]` | `--mount` (repeat) | Live RW bind mount. **Writes host.** Same anchor as `cp`. |
| `base` | string | `--base` | Base ref for the `ccairgap/<id>` branch. Default: HEAD of each repo. |
| `keep-container` | bool | `--keep-container` | Omit `docker run --rm`. |
| `dockerfile` | string | `--dockerfile` | Custom Dockerfile path. Relative → resolved against the **config file's directory** (sidecar convention). |
| `docker-build-arg` | `{KEY: "VAL"}` | `--docker-build-arg` (repeat) | Map. Most common key: `CLAUDE_CODE_VERSION`. |
| `rebuild` | bool | `--rebuild` | Force image rebuild. |
| `print` | string | `-p` / `--print` | Non-interactive prompt. |
| `name` | string | `-n` / `--name` | Session id prefix; final id is `<name>-<4hex>`. Branch becomes `ccairgap/<id>`. |
| `hooks.enable` | `[string]` | `--hook-enable` (repeat) | Glob against hook `command` string. See [hooks.md](hooks.md). |
| `mcp.enable` | `[string]` | `--mcp-enable` (repeat) | Glob against MCP server `name`. Project-scope `<repo>/.mcp.json` additionally requires host approval. See [mcp.md](mcp.md). |
| `docker-run-arg` | `[string]` | `--docker-run-arg` (repeat) | Raw docker tokens, shell-split. See [docker-run-args.md](docker-run-args.md). |
| `warn-docker-args` | bool | `--no-warn-docker-args` (inverted) | Default true. Set false to silence the danger-token warning. |
| `claude-args` | `[string]` | `-- <token> …` (tail) | Tokens forwarded verbatim to `claude` inside the container, subject to the denylist. Config first, CLI `--` tail appended. |
| `no-auto-memory` | bool | `--no-auto-memory` | Skip the auto-memory RO mount. Default false. |
| `clipboard` | bool | `--no-clipboard` (inverted) | Default true. Set `clipboard: false` to disable image-clipboard passthrough. See [clipboard.md](clipboard.md). |
| `no-preserve-dirty` | bool | `--no-preserve-dirty` | Skip dirty-working-tree preservation on exit. Default false. For scripted / CI use. |
| `refresh-below-ttl` | number (minutes) | `--refresh-below-ttl` | Host token ttl threshold for pre-launch auth refresh. Default 120. `0` disables the refresh; cold-start-dead refusal still fires. See [auth-refresh.md](auth-refresh.md). |

## Profiles

`--profile <name>` picks a named config file under the same canonical dir:

- `--profile default` → `config.yaml` (same as no flag).
- `--profile web` → `web.config.yaml` (e.g. `<git-root>/.ccairgap/web.config.yaml`, fallback `<git-root>/.config/ccairgap/web.config.yaml`).

Missing profile file is a hard error. Mutually exclusive with `--config`. No inheritance between profiles — each file stands alone. Profile name regex: `[A-Za-z0-9._-]+`. Relative paths inside a profile file anchor the same way as `config.yaml`.

## Path resolution

Three anchors, chosen by the semantic of each key. Absolute paths always work and bypass anchoring. This is the single most common source of confusion — read carefully.

### 1. Workspace anchor — for `repo`, `extra-repo`, `ro`

These describe **repo-space**: your project, sibling repos, reference dirs next to your project. The anchor is the **git root** when the config lives at either canonical location (`<git-root>/.ccairgap/config.yaml` or `<git-root>/.config/ccairgap/config.yaml`). When `--config` points elsewhere (outside either canonical layout), the anchor falls back to the config file's own directory.

In the canonical layout:

| You write | Resolves to |
|-----------|-------------|
| `repo: .` | the git root (same as omitting `repo` entirely) |
| `repo: ..` | the parent of the git root |
| `extra-repo: [../sibling]` | a sibling of the git root |
| `ro: [../docs]` | a sibling of the git root |
| `ro: [~/src/reference-material]` | tilde expansion is **not** done by ccairgap — use an absolute path or `$HOME/...` in a shell wrapper |

**Rule of thumb:** write these paths as if you were standing in the git root, not in `.ccairgap/`.

### 2. Config-file-directory anchor — for `dockerfile`

The Dockerfile is a sidecar file that lives next to `config.yaml` (the same directory, whichever canonical location you use):

| You write | Resolves to (for `<git-root>/.ccairgap/config.yaml`) |
|-----------|-------------|
| `dockerfile: Dockerfile` | `<git-root>/.ccairgap/Dockerfile` |
| `dockerfile: ./images/custom.Dockerfile` | `<git-root>/.ccairgap/images/custom.Dockerfile` |

(For `<git-root>/.config/ccairgap/config.yaml`, swap in `.config/ccairgap/` everywhere.)

### 3. Workspace-repo-root anchor — for `cp`, `sync`, `mount`

These name paths **inside the workspace repo** (`node_modules`, `dist`, `.cache`). Resolved at launch, against `--repo`'s absolute path:

| You write (with `--repo ~/src/foo`) | Resolves to |
|-----------|-------------|
| `cp: [node_modules]` | `~/src/foo/node_modules` |
| `sync: [dist]` | `~/src/foo/dist` |
| `mount: [.cache]` | `~/src/foo/.cache` |

This matches how a user thinks about artifacts ("the `node_modules` in my project"), not where the YAML happens to live.

### `repo` is optional

If omitted, `repo` defaults to the git root containing the config file (or `cwd` if no config is loaded). Most canonical setups can drop the key entirely — it's there for the rare case where you want the workspace to be a sibling dir rather than the repo that owns the config.

## Canonical example

```yaml
# <git-root>/.ccairgap/config.yaml

# Workspace-space (anchored on git root):
# repo is optional — defaults to the git root. Shown here for clarity.
repo: .

extra-repo:
  - ../sibling-repo       # sibling of the git root

ro:
  - ../docs               # sibling of the git root
  - /opt/reference-data   # absolute path — always works

# Build artifacts (anchored on workspace repo root at launch):
# node_modules: fast iterative cache → live bind.
mount:
  - node_modules

# dist/: container produces it, we want the result afterwards, but don't want
# the container touching the host's original copy.
sync:
  - dist

# Hooks: disabled by default; enable the python3 auto-approve hook by matching
# its `command` string. (Don't list the statusline command — `statusLine` is
# not a hook in ccairgap's filtering and runs by default.)
hooks:
  enable:
    - "python3 *"

# Pin Claude Code version inside the container image.
docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"

# Expose the Vite dev server port so the host can reach it.
docker-run-arg:
  - "-p 5173:5173"

# Extend the default image with project-specific binaries. Anchored on the
# config file's directory, so this resolves to <git-root>/.ccairgap/Dockerfile.
dockerfile: Dockerfile
```

## Minimal examples

**"I just want to run ccairgap in my repo":** no config file needed. `cd <repo> && ccairgap`.

**"I need node_modules to persist across sessions":**
```yaml
mount:
  - node_modules   # anchored on workspace repo root
```

**"My project has a sibling repo Claude reads for types":**
```yaml
# shared-types lives next to the git root.
ro:
  - ../shared-types
```

**"I need Playwright and a port exposed":**
```yaml
dockerfile: Dockerfile     # custom, installs Playwright
docker-run-arg:
  - "-p 9323:9323"         # Playwright report server
```

## Keys that do NOT exist

Don't invent keys. The validator rejects unknown keys. If you need behavior not covered by any key, tell us — the fix is likely a SPEC change, not a config shape.

Notably absent (by design):
- No `env` or `environment` key — pass env vars via `docker-run-arg: ["-e FOO=bar"]`.
- No `ports` key — use `docker-run-arg: ["-p 8080:8080"]`.
- No `network` key — use `docker-run-arg: ["--network my-net"]`.
- No `volumes` key distinct from `ro`/`cp`/`sync`/`mount` — those cover the structured cases; exotic mounts go through `docker-run-arg`.
- No hook disable list (only enable) — default is "all disabled", enable is the only opt-in.
- No MCP disable list (only enable) — default is "all disabled", enable is the only opt-in. Same model as hooks.

## User-wide config

A second config layer loaded before the project config. Location: `$XDG_CONFIG_HOME/ccairgap/` (default `~/.config/ccairgap/`). Scaffold it with `ccairgap init --user`.

### Load order

**defaults < user-wide-integrations < user-wide-config < project < CLI**

- `~/.config/ccairgap/integrations/*.yaml` are loaded first (alphabetical order), then
- `~/.config/ccairgap/config.yaml`, then
- `<git-root>/.ccairgap/config.yaml` (or profile variant), then
- CLI flags.

Scalars: higher-precedence layer wins. Arrays: lower-precedence first, then appended by higher layers. Maps: per-key merge, higher-precedence wins.

### File vocabulary

| Path | Role |
|---|---|
| `config.yaml` | Persistent defaults — every `ConfigFile` key is accepted, with the exception of relative `repo`/`extra-repo`/`ro`/`cp`/`sync`/`mount` (hard error; no workspace anchor at user-wide scope). `dockerfile:` anchors on the user-wide config dir. |
| `<name>.config.yaml` | **Reserved.** User-wide profiles are not loaded. Writing one emits a stderr warning and an informational `doctor` row. Profiles (`--profile <name>`) only swap the project layer. |
| `integrations/*.yaml` | Per-tool drop-ins; see "Integration drop-ins" below. |
| `CLAUDE.md` | Appended to in-container `~/.claude/CLAUDE.md` before the project `.ccairgap/CLAUDE.md` block. |
| `settings.json` | Deep-merged into `~/.claude/settings.json` after policy filtering; bypasses `--hook-enable` by design. |
| `mcp.json` | `mcpServers` merged into `~/.claude.json`; bypasses `--mcp-enable` by design. |
| `skills/` | Rsynced into `~/.claude/skills/`. |
| `Dockerfile` | Custom Dockerfile sidecar; opt-in via `dockerfile: Dockerfile` in `config.yaml`. |

### Integration drop-ins

Files in `integrations/*.yaml` are tool-specific config fragments. They are strictly allowlisted — only the following top-level keys are accepted:

| Key | Semantics |
|---|---|
| `hooks.enable` | `[string]` — glob patterns; merged at lower precedence than `config.yaml`. |
| `mcp.enable` | `[string]` — glob patterns; merged at lower precedence than `config.yaml`. |
| `docker-run-arg` | `[string]` — raw docker tokens; safe-flag allowlist enforced (see below). |

Any other top-level key hard-errors at load time.

**`docker-run-arg` safe-flag allowlist.** Integration files may only emit the following docker flags:

- `-e` / `--env` / `--env=` — environment variables
- `--add-host` — extra `/etc/hosts` entries
- `--label` — container labels
- `--dns` — DNS server
- `--dns-search` — DNS search domain

Flags that affect isolation (`-v`, `--user`, `--cap-add`, `--name`, `--entrypoint`, `--privileged`, `--network`, etc.) hard-error. User-authored `~/.config/ccairgap/config.yaml` uses the existing warning-only dangerous-arg scanner — not the strict allowlist.

**`-e`/`--env` token-form restriction.** The integration validator accepts the two-token form (`-e KEY=VAL`) and the `=`-joined form (`--env=KEY=VAL` or `-e=KEY=VAL`), but rejects the clustered short-flag form `-eKEY=VAL` (no space, no `=` separator). Rewrite any `-eKEY=VAL` tokens as `-e KEY=VAL`. This restriction applies only to integration drop-ins; `docker-run-arg` in `config.yaml` and the CLI `--docker-run-arg` flag accept all forms Docker accepts.

### Profile interaction

`--profile <name>` swaps the **project** layer only (`<git-root>/.ccairgap/<name>.config.yaml`). The user-wide layer is always `config.yaml` — there is no user-wide profile concept. Writing a `<name>.config.yaml` in `~/.config/ccairgap/` is reserved; it emits a stderr warning and appears in `ccairgap doctor`.

### `--bare` and `--no-user-config`

- `--bare` skips the user-wide `config.yaml` and `integrations/*.yaml` (launch config). It does **not** skip the user-wide `CLAUDE.md` / `settings.json` / `mcp.json` / `skills/` injection (session environment).
- `--no-user-config` is the non-`--bare` kill switch for the entire user-wide layer: skips both launch-config loading and the `/ccairgap-user-dir` injection mount.

### Examples

**Scaffold the user-wide dir:**
```bash
ccairgap init --user
```

**`~/.config/ccairgap/config.yaml` — persistent user defaults:**
```yaml
# Pin Claude Code version for all projects.
docker-build-arg:
  CLAUDE_CODE_VERSION: "1.2.3"

# Always enable the python3 auto-approve hook.
hooks:
  enable:
    - "python3 *"

# Disable clipboard passthrough globally.
clipboard: false

# Absolute paths work; relative repo/extra-repo/ro/cp/sync/mount are hard errors here.
ro:
  - /opt/shared-reference-data
```

**`~/.config/ccairgap/integrations/my-tool.yaml` — per-tool drop-in:**
```yaml
# Enable an MCP server provided by my-tool.
mcp:
  enable:
    - "my-tool-mcp"

# Expose my-tool's API key to all containers.
docker-run-arg:
  - "-e MY_TOOL_API_KEY=abc123"
```
