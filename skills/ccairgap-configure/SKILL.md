---
name: ccairgap-configure
description: Configure `ccairgap` (claude-airgap) for a specific project or workflow — produces `.claude-airgap/config.yaml`, a custom `Dockerfile`, and/or `--docker-run-arg` snippets. Use this whenever the user wants to set up ccairgap, add something to their sandboxed container (MCP server, extra binary, cache dir, port, network, env var), enable a hook inside the sandbox, extend or customize the base image, figure out whether a build artifact should be `--cp` / `--sync` / `--mount`, or otherwise asks "how do I make ccairgap do X". Also trigger when the user mentions claude-airgap, `ccairgap`, or "the airgap container" and is trying to shape its behavior. Don't skip this skill just because the user hasn't used the word "configure" — most setup questions land here.
---

# ccairgap-configure

`ccairgap` runs Claude Code with `--dangerously-skip-permissions` inside a Docker container. Three configuration surfaces:

1. **`.claude-airgap/config.yaml`** — same keys as CLI flags. Default path `<git-root>/.claude-airgap/config.yaml`.
2. **Custom `Dockerfile`** — extend the bundled `node:20-slim` base when a workflow needs binaries not shipped by default (Python, Playwright, language-specific toolchains, MCP servers). Passed via `--dockerfile <path>`.
3. **`--docker-run-arg <tokens>`** — raw `docker run` args appended after built-ins. Used for ports, networks, extra env vars, and any other `docker run` knob the CLI does not surface as a structured flag.

Your job: pick the **minimum** of those three that actually delivers what the user wants, then emit the artifacts with enough comments that the user understands each choice.

## Core flow

Work through these phases in order. Don't skip ahead.

### Phase 1 — Gather

Before proposing anything, probe the host so your recommendation is grounded. Read `references/gathering-context.md` for the full probe checklist; at minimum, find out:

- **Project shape.** Git repo root, sibling repos the user might want mounted, dominant language / runtime (look for `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.), build-artifact dirs (`node_modules`, `.venv`, `target/`, `dist/`, `.cache/`).
- **Claude setup.** User's `~/.claude/settings.json` (hooks, `extraKnownMarketplaces`, env), `~/.claude.json` (`mcpServers`), project `.claude/settings.json[.local]` (project-scoped hooks).
- **Binary dependencies.** What does the user's workflow shell out to? Look at hook `command` strings, MCP `command` fields, `package.json` scripts, CI config. Anything not in the base image (`git`, `git-lfs`, `curl`, `jq`, `rsync`, `ca-certificates`, `less`, `vim`, `node`, `npm`) is a candidate for Dockerfile extension.
- **Ports / networks / env.** Does the workflow run a dev server the user wants to hit from the host? Attach to a named docker network? Need an API key env var? These are `--docker-run-arg` territory.
- **Trust boundary on artifact dirs.** For each build-artifact dir (`node_modules`, etc.), is the user OK with the container writing directly to the host (fast, `--mount`), wants a copy they can discard (`--cp`), or wants results staged to `output/<ts>/` for manual review (`--sync`)?

Do the probing with real tool calls — `git rev-parse --show-toplevel`, reading files — not by guessing.

### Phase 2 — Align

State back what you found and what you propose, **before writing any artifact**. Example shape:

> I see a Node/TypeScript project with `node_modules` (~800 MB) and a local `.cache/` dir. Your `~/.claude/settings.json` has a `python3 ~/scripts/auto-approve.py` PreToolUse hook. You mentioned wanting Playwright to work inside the container and to hit a dev server on port 5173.
>
> Proposed config:
> - `config.yaml`: mount sibling repo `../shared-types` read-only, `--mount node_modules` (live cache, fastest iteration), `--sync dist` (keep build output in `output/<ts>/`), enable the `python3 *` hook.
> - Custom `Dockerfile`: base + Python 3 + Playwright browsers (Chromium).
> - Docker run args: `-p 5173:5173` to expose the dev server.
>
> Confirm or tell me what to change.

Wait for the user to confirm or redirect before producing files. Users routinely want to adjust the trust decisions (e.g. "actually use `--sync` for `node_modules`, I don't trust this task") — surface those choices rather than silently committing to one.

### Phase 3 — Produce

Emit the minimum artifact set needed. **Only produce what's actually required** — if the user only needs a `config.yaml`, don't invent a Dockerfile. If all they need is one `--docker-run-arg`, a one-liner they can copy/paste is better than a YAML file.

Default locations (adjust if the user prefers elsewhere):

- Config: `<git-root>/.claude-airgap/config.yaml` — this is the path ccairgap reads by default, so no `--config` flag is needed.
- Dockerfile: `<git-root>/.claude-airgap/Dockerfile` — keep it alongside the config, then set `dockerfile: Dockerfile` in `config.yaml` (the `dockerfile` key anchors on the config file's own directory, so a bare filename resolves to the sidecar).
- Raw docker run args: put them in the config file under `docker-run-arg:` unless the user wants them ad-hoc at the CLI.

Every artifact should be **commented**. Treat the YAML and the Dockerfile as teaching artifacts — the user has to live with them. Explain why each non-default key is there in a short inline comment.

## Artifact decision — which surface?

This is the most common source of confusion. Use this decision tree; full matrix in `references/artifact-decision.md`.

**Is this a launch flag that already exists?** → put it in `config.yaml`. The repeatable array flags (`extra-repo`, `ro`, `cp`, `sync`, `mount`, `docker-build-arg`, `docker-run-arg`, `hook-enable`) are all config-file keys. See `references/config-schema.md`.

**Is this a binary or package the workflow shells out to but isn't in the base image?** → custom `Dockerfile` that `FROM`s the base and adds the binary. See `references/dockerfile-patterns.md`.

**Is this a `docker run` capability the CLI doesn't have a dedicated flag for** (port publish, custom network, extra env var, extra `-v` mount with exotic options, etc.)? → `--docker-run-arg` (structured) or `docker-run-arg:` in config. See `references/docker-run-args.md`.

**Is this a build-artifact directory** (`node_modules`, `.venv`, `target/`, build caches)? → `--cp` / `--sync` / `--mount` depending on the trust + performance tradeoff the user picked. See `references/artifact-decision.md`.

**Is this a Claude Code hook** the user wants to keep active inside the sandbox? → `--hook-enable '<glob>'` matched against the hook's `command` string. All hooks are disabled by default. See `references/hook-patterns.md`.

## Host-write invariant (read this before adding any mount)

The whole point of ccairgap is that the host filesystem cannot be mutated outside a small, explicit set of paths (see SPEC §"Host writable paths"). Every recommendation you make must respect this:

- `--cp` and `--sync` never write the original host path. Safe by default.
- `--mount` **does** write the host path live. This is an explicit opt-in weakening of the host-write invariant for one path. Use when the user explicitly wants it (typically `node_modules` or a language cache) and understands the tradeoff.
- `--docker-run-arg "-v <host>:<ctr>:rw"` also writes host. If the only goal is a single RW path, prefer `--mount <path>` — it's narrower in intent.
- Raw docker args like `--privileged`, `--cap-add SYS_ADMIN`, `--network=host`, `--pid=host`, or mounting `/var/run/docker.sock` **eliminate the isolation this tool provides**. Don't recommend these unless the user is knowingly disabling the sandbox and has a concrete reason. The CLI prints a warning per hit; your recommendation should too.

When in doubt, pick the less permissive option and tell the user how to upgrade.

## Dockerfile extension rules

Custom Dockerfiles are expected to `FROM` something compatible with the bundled one. The entrypoint and user setup depend on specific paths and a non-root user. Key invariants (full details in `references/dockerfile-patterns.md`):

- Base should provide `node` (for Claude Code) or install it. Default is `node:20-slim`.
- Keep `ARG HOST_UID`, `ARG HOST_GID`, `ARG CLAUDE_CODE_VERSION` passthroughs — the CLI always passes these at build time.
- Keep the non-root `claude` user at `HOST_UID:HOST_GID` and the entrypoint at `/usr/local/bin/claude-airgap-entrypoint`.
- The safest pattern is `FROM` a stock image that already has Node, add your extras (apt packages, pip packages, Playwright browsers, etc.), then replicate the user/entrypoint boilerplate. An even safer pattern when supported: `FROM claude-airgap:<cli-version>` and `RUN` only the additions — but this requires the base tag to exist locally, which is not guaranteed on first run.

Image tag for custom Dockerfiles is `claude-airgap:custom-<sha256(dockerfile)[:12]>` — content-addressed, so rebuilds skip automatically when the file doesn't change. Forcing a rebuild: `--rebuild`.

## docker-run-arg rules

Raw args are appended **after** the CLI's built-ins, so Docker's last-wins resolution lets user args override defaults (`--network`, a narrower `--cap-drop`, etc.). Each `--docker-run-arg <value>` is shell-split with `shell-quote`, so quoting works like a shell. Full cookbook in `references/docker-run-args.md`.

Rules of thumb:

- Publishing a dev server port: `--docker-run-arg "-p 5173:5173"`.
- Attaching to an existing network the user created: `--docker-run-arg "--network my-net"`.
- Extra env var: `--docker-run-arg "-e API_KEY=$API_KEY"` — be careful about shell expansion; this happens on the host at launch, so the var needs to exist on the host.
- Additional RW mount: prefer `--mount <path>` unless you need mount options the CLI doesn't pass. If you do use raw, it's `--docker-run-arg "-v /host/path:/ctr/path:rw"`.

## Hook policy cheat sheet

All hooks are disabled by default inside the container (`disableAllHooks: true` is injected). Re-enable per-command with globs against the raw `command` string. Anchored full match, `*` is wildcard. Full cookbook in `references/hook-patterns.md`.

Common patterns:

```yaml
hooks:
  enable:
    - "python3 *"                              # any python3 hook
    - "bash ~/.claude/statusline.sh"           # exact statusline
    - "*/auto-approve.py *"                    # any command ending in auto-approve.py
```

Important caveat: enabling a hook doesn't guarantee it works — the command's binary must exist inside the container. If the hook shells out to a host-only binary, either install it via the custom Dockerfile or leave the hook disabled.

## Assets

Use these as starting points, don't copy them verbatim — strip keys the user doesn't need, keep comments that justify what's left.

- `assets/config.yaml.template` — annotated skeleton covering every supported key. Delete what isn't used.
- `assets/Dockerfile.template` — extend-base skeleton with placeholder for extra apt/pip/npm installs.

## Reference files

Read the reference you need, not all of them.

| File | Read when |
|------|-----------|
| `references/gathering-context.md` | Always, during Phase 1 — the probe checklist. |
| `references/config-schema.md` | User asks about any config key, precedence, or where relative paths resolve. |
| `references/dockerfile-patterns.md` | User needs Python / Playwright / Rust / a specific MCP / any non-default binary. |
| `references/docker-run-args.md` | Ports, networks, env vars, exotic mounts, or any raw docker args. |
| `references/artifact-decision.md` | Choosing between `--cp` / `--sync` / `--mount` for a directory. |
| `references/hook-patterns.md` | Enabling hooks, understanding which get disabled. |

## Common traps

- **Don't put host-absolute paths in committed `config.yaml`.** Use relative paths. Three anchors: `repo`/`extra-repo`/`ro` resolve against the **git root** (the parent of `.claude-airgap/`) — write them as if you're standing in the repo root. `dockerfile` resolves against the **config file's directory** (sidecar, so `dockerfile: Dockerfile` finds `.claude-airgap/Dockerfile`). `cp`/`sync`/`mount` resolve against the **workspace repo root** at launch. Absolute paths work but don't transfer between teammates.
- **Don't recommend `--privileged` or `docker.sock` mounts to "make it work".** If something doesn't work, diagnose first. These obliterate the sandbox.
- **Don't forget UID/GID.** The base Dockerfile's `ARG HOST_UID` / `ARG HOST_GID` pattern is load-bearing for bind-mount file ownership. Custom Dockerfiles that skip this will write root-owned files to the host on bind mounts.
- **Don't mount `~/.claude/` RW.** It's RO by design — session mutations (permission cache, prompt history) die with the container. Users asking to persist these are usually asking the wrong question; talk them through it.
- **Don't confuse `--cp` with Docker's `COPY`.** `--cp` is a pre-launch rsync from host to session scratch; container sees it RW at the same absolute path; changes discarded on exit.
- **Don't add config keys that don't exist in SPEC.** If the user asks for a new behavior not in `docs/SPEC.md`, tell them — adding flags is a SPEC change, not a config-file workaround.
