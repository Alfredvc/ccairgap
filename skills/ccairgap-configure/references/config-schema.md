# Config schema — `.ccairgap/config.yaml`

Default path: `<git-root>/.ccairgap/config.yaml`. Override with `--config <path>`. Both kebab-case (matches CLI flag names) and camelCase keys are accepted — kebab is preferred because it mirrors the flags.

Unknown keys or wrong types abort launch with a clear error. The CLI validator is source of truth (`src/config.ts`) — this table mirrors it.

## Key reference

| YAML key | Type | Equivalent flag | Notes |
|----------|------|-----------------|-------|
| `repo` | string | `--repo` | Workspace repo. Single path. **Optional** — defaults to the git root containing the config. Relative → resolved against the **workspace anchor** (git root when config is at canonical `<git-root>/.ccairgap/config.yaml`). |
| `extra-repo` | `[string]` | `--extra-repo` (repeat) | Additional repos mounted + cloned. Same anchor as `repo`. Not the workspace. |
| `ro` | `[string]` | `--ro` (repeat) | RO bind mounts. Any path. Same anchor as `repo`. |
| `cp` | `[string]` | `--cp` (repeat) | Copy-in-discard. Relative → resolved against **workspace repo root**. |
| `sync` | `[string]` | `--sync` (repeat) | Copy-in, copy-out-on-exit to `$CCAIRGAP_HOME/output/<ts>/`. Same anchor as `cp`. |
| `mount` | `[string]` | `--mount` (repeat) | Live RW bind mount. **Writes host.** Same anchor as `cp`. |
| `base` | string | `--base` | Base ref for the `ccairgap/<ts>` branch. Default: HEAD. |
| `keep-container` | bool | `--keep-container` | Omit `docker run --rm`. |
| `dockerfile` | string | `--dockerfile` | Custom Dockerfile path. Relative → resolved against the **config file's directory** (sidecar convention). |
| `docker-build-arg` | `{KEY: "VAL"}` | `--docker-build-arg` (repeat) | Map. Most common key: `CLAUDE_CODE_VERSION`. |
| `rebuild` | bool | `--rebuild` | Force image rebuild. |
| `print` | string | `-p` / `--print` | Non-interactive prompt. |
| `name` | string | `-n` / `--name` | Session name; branch becomes `ccairgap/<name>`. |
| `hooks.enable` | `[string]` | `--hook-enable` (repeat) | Glob against hook `command` string. |
| `docker-run-arg` | `[string]` | `--docker-run-arg` (repeat) | Raw docker tokens, shell-split. |
| `warn-docker-args` | bool | `--no-warn-docker-args` (inverted) | Default true. Set false to silence the danger-token warning. |

## Precedence

**CLI > config > built-in defaults.**

- Scalars (`repo`, `base`, `dockerfile`, `print`, `name`, `keep-container`, `rebuild`, `warn-docker-args`): CLI wins if passed.
- Arrays (`extra-repo`, `ro`, `cp`, `sync`, `mount`, `docker-run-arg`, `hooks.enable`): config values first, CLI appended. No dedup.
- Maps (`docker-build-arg`): per-key merge; CLI value wins for overlapping keys.

## Path resolution

Three anchors, chosen by the semantic of each key. Absolute paths always work (and bypass anchoring). This is the single most common source of confusion — read carefully.

### 1. Workspace anchor — for `repo`, `extra-repo`, `ro`

These describe **repo-space**: your project, sibling repos, reference dirs next to your project. The anchor is the **git root** when the config lives at the canonical `<git-root>/.ccairgap/config.yaml` (which is the default). When `--config` points elsewhere (outside any `.ccairgap/` dir), the anchor falls back to the config file's own directory.

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

The Dockerfile is a sidecar file that lives next to `config.yaml`:

| You write | Resolves to (for `<git-root>/.ccairgap/config.yaml`) |
|-----------|-------------|
| `dockerfile: Dockerfile` | `<git-root>/.ccairgap/Dockerfile` |
| `dockerfile: ./images/custom.Dockerfile` | `<git-root>/.ccairgap/images/custom.Dockerfile` |

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

# Hooks: disabled by default; enable the python3 auto-approve hook and the
# statusline script by matching their `command` strings.
hooks:
  enable:
    - "python3 *"
    - "bash ~/.claude/statusline.sh"

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

Don't invent keys. The validator rejects unknown keys. If the user asks for behavior not covered by any key, tell them — the fix is likely a SPEC change, not a config shape.

Notably absent (by design):
- No `env` or `environment` key — pass env vars via `docker-run-arg: ["-e FOO=bar"]`.
- No `ports` key — use `docker-run-arg: ["-p 8080:8080"]`.
- No `network` key — use `docker-run-arg: ["--network my-net"]`.
- No `volumes` key distinct from `ro`/`cp`/`sync`/`mount` — those cover the structured cases; exotic mounts go through `docker-run-arg`.
- No hook disable list (only enable) — default is "all disabled", enable is the only opt-in.
