---
name: ccairgap-configure
description: Configure `ccairgap` — produces `.ccairgap/config.yaml` and/or a custom `Dockerfile`. Use when user wants to set up ccairgap, add a binary/MCP/toolchain, enable a sandbox hook, expose a sibling repo, or asks "how do I make ccairgap do X". Trigger on any ccairgap shaping question, even without the word "configure".
---

# ccairgap-configure

`ccairgap` runs Claude Code with `--dangerously-skip-permissions` inside a Docker container. Two configuration surfaces handle almost every real request:

1. **`.ccairgap/config.yaml`** — project-scoped, same keys as CLI flags. Default path `<git-root>/.ccairgap/config.yaml`, with `<git-root>/.config/ccairgap/config.yaml` as a fallback (loaded only when the primary is absent; if both exist, ccairgap warns and uses the primary). **This is where almost every change belongs — anything tied to a specific repo (gitignored mounts, repo-specific hooks/MCPs, per-repo Dockerfile).**
2. **Custom `Dockerfile`** — extend the published ccairgap image when a workflow needs binaries not shipped by default (uv, Playwright browsers, language toolchains, MCP server binaries). Referenced via `dockerfile:` in config.

A user-wide layer (`~/.config/ccairgap/`, scaffolded via `ccairgap init --user`) also exists for cross-project defaults — but **default to project config**. Only suggest user-wide when the user explicitly says they want a setting across every project, or for third-party integration drop-ins (`integrations/*.yaml`, allowlisted to `hooks.enable` / `mcp.enable` / safe `docker-run-arg`). Most users never need it. Full layer reference: `references/config-schema.md`.

There is a third surface — `--docker-run-arg` — but it is an escape hatch, not a recommendation you should reach for. See "When `docker-run-arg` is *not* the answer" below. **Do not propose it unless the user has explicitly described a need it addresses.**

Your core job is narrow:

1. **Find binary dependencies** the workflow needs inside the container → add to a custom Dockerfile.
2. **Find the directories** Claude needs to see → default them to `--ro` mounts, escalate to read-write only when the user asks for it or the workflow literally cannot work otherwise.

Everything else is opt-in.

## The gitignore rule

`ccairgap` clones the workspace repo into session scratch. Only **git-tracked files** land in the clone. Anything gitignored — `node_modules`, `target/`, `.venv`, `dist/`, `.next/`, etc. — is **missing from the container by default**. Claude opens the sandbox and sees a repo without its dependencies; imports fail to resolve, LSP doesn't work, grep over third-party code is impossible.

For every known large build/cache directory that (a) exists on the host and (b) is gitignored, the default is to `--ro` mount it. Read-only is enough for Claude to resolve imports, read dep source, and understand the dep graph. If the user also needs to run builds/tests that write into those dirs, they will tell you — then escalate to `--mount` (host writes) or `--cp` (session-local, discarded on exit).

### Known dirs to check

Walk this list for each detected project type. For each dir: run `git check-ignore <path>` (or read `.gitignore`) AND confirm `<path>` exists on the host. If both, add to `ro:` by default.

| Project type | Dirs to check |
|---|---|
| Node / Bun / Deno (`package.json`, `bun.lockb`, `deno.json`) | `node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `dist`, `build`, `out`, `.cache` |
| Python (`pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py`) | `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.tox` |
| Rust (`Cargo.toml`) | `target` |
| Go (`go.mod`) | `vendor` (only if gitignored — some repos commit it) |
| JVM (`pom.xml`, `build.gradle`, `build.gradle.kts`) | `target`, `build`, `.gradle` |
| Ruby (`Gemfile`) | `vendor/bundle` |
| iOS / Xcode (`*.xcodeproj`, `Podfile`) | `Pods`, `DerivedData` |

Narrow rules:

- **Only include a dir if it's gitignored on this repo.** `git check-ignore node_modules` returning 0 is the signal. A repo that commits `node_modules` (rare, but exists) doesn't need the mount.
- **Only include a dir that actually exists on the host.** Don't add `target` to `ro:` for a Node project.
- **Tiny caches aren't worth it.** `__pycache__` inside the tree is gitignored but regenerates in milliseconds; skip. The test is "would regeneration take more than a few seconds to start useful work" — if no, omit.
- **Never escalate past `--ro` without user consent.** If the user asks Claude to run `npm install`, `cargo test`, or any command that writes to these dirs, say so: "that needs write access to `node_modules` — should I switch it to `--mount` (writes land on host) or `--cp` (session-local copy, discarded on exit)?"
- **Dirs outside the workspace repo are out of scope for this rule.** The gitignore check is per-workspace. For sibling dirs Claude needs to read, ask the user what they want.

## Core flow

Work through these phases in order. Don't skip ahead.

### Phase 1 — Gather

Probe the host so your recommendation is grounded. Read `references/gathering-context.md` for the full probe checklist; at minimum:

- **Project shape.** Git repo root, dominant language / runtime (look for `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.), sibling repos or docs dirs the user might be reading from.
- **Claude setup.** Run `ccairgap inspect` — one call returns JSON `{hooks, mcpServers, env, marketplaces}` covering every surface (user, user-project, plugin, project) including env vars and `extraKnownMarketplaces`. Only hand-walk the underlying files (`~/.claude/settings.json`, `~/.claude.json`, project `.claude/settings.json[.local]`, `<repo>/.mcp.json`) when `inspect` is unavailable on an older ccairgap version.
- **Binary dependencies.** What does the user's workflow shell out to? Hook `command` strings, MCP `command` fields, `package.json` scripts, CI config, `.tool-versions`/`.nvmrc`/`.python-version`. Anything not in the base image (`node`, `npm`, `git`, `git-lfs`, `curl`, `jq`, `rsync`, `ca-certificates`, `less`, `vim`, `python3`, `pip`, `@anthropic-ai/claude-code`, `@openai/codex`) is a Dockerfile candidate.
- **Reference directories.** Sibling repos, shared type packages, docs trees, reference datasets — these become `--ro` mounts or `--extra-repo` entries. Be specific: identify what exists on the host and would actually be read during the session.

Do the probing with real tool calls — `git rev-parse --show-toplevel`, reading files — not by guessing.

**What you do *not* probe for by default:** `.env` files, `~/.ssh`, `~/.aws`, `~/.gcloud`, password managers, keychains, API keys in shell rc files. These are off-limits unless the user has explicitly asked you to wire one in. See `references/secrets-and-sensitive-data.md`.

### Phase 2 — Align

State back what you found and what you propose, **before writing any artifact**. Keep the proposal minimal. Example shape:

> I see a Node/TypeScript project. Gitignored dirs present on host: `node_modules`, `.next`, `dist`. Your `~/.claude/settings.json` has a `python3 ~/scripts/auto-approve.py` PreToolUse hook. Your `~/.claude.json` has a Playwright MCP server.
>
> Proposed config:
> - `config.yaml`: `ro:` mount `node_modules`, `.next`, `dist` (gitignored, so the session clone would be missing them — RO gives Claude read access without host writes); `ro:` sibling `../shared-types`; enable the `python3 *` hook.
> - Custom `Dockerfile`: base + Python 3 (for the auto-approve hook) + Playwright system libs (for the MCP).
>
> I did *not* add: write access for any of those dirs (so `npm install` / `npm run build` will fail inside the sandbox — tell me if you need those, and for which dirs I should escalate to `--cp` or `--mount`), any port publish, any env var passthrough. Those are opt-in.
>
> Confirm or tell me what to change.

Be explicit about what you chose *not* to add. That way the user can redirect before artifacts land.

Wait for confirmation before producing files.

### Phase 3 — Produce

Emit the minimum artifact set needed. If the user only needs a `config.yaml`, don't invent a Dockerfile. If all they need is a one-line `--hook-enable`, a CLI snippet is better than a YAML file.

Default locations (adjust if the user prefers elsewhere):

- Config: `<git-root>/.ccairgap/config.yaml` — ccairgap's default path, no `--config` needed. (`<git-root>/.config/ccairgap/config.yaml` also works as a fallback — use it only if the project already keeps tool configs under `.config/`.)
- Dockerfile: `<git-root>/.ccairgap/Dockerfile` — set `dockerfile: Dockerfile` in config (sidecar convention).

Every artifact should be **commented**. Treat the YAML and the Dockerfile as teaching artifacts the user has to live with. Explain why each non-default key is there in a short inline comment. **Delete keys the user doesn't use — do not ship the full template with commented-out examples.**

## Directory escalation ladder

This is the decision you'll make most often. Default to the *least* permissive option, escalate only when pushed.

| Level | Surface | Host written? | Use when |
|-------|---------|---------------|----------|
| 0 — nothing | (no config entry) | no | The workspace repo itself (built-in mount covers it). Non-gitignored paths. |
| 1 — read-only | `ro: [<path>]` | no | **Default for gitignored large build/cache dirs** (`node_modules`, `target`, `.venv`, etc. — see the gitignore rule above). Also for reference material outside the repo: sibling types package, docs tree, shared config. |
| 2 — sibling repo, sandboxed | `extra-repo: [<path>]` | no (gets own sandbox branch) | A second git repo the user is actively editing alongside the workspace. Same safety as `--repo` — clone + sandbox branch + fetch-on-exit. |
| 3 — copy in, discard | `cp: [<path>]` | no | User has asked Claude to run something that *writes* into the dir (build, test, install) but doesn't want those changes preserved. Session gets a full mutable copy; discarded on exit. |
| 4 — copy in, copy out | `sync: [<path>]` | no | Build output the user wants after the session without touching the host original. Opt in when the user says "I want to keep the build". |
| 5 — live bind, host writes | `mount: [<path>]` | **yes** | Cache/artifact dir where regeneration is expensive *and* the user has said so. Weakens the host-write invariant for that one path. Never default. |

**Never escalate past level 1 without one of:**
- The user explicitly asked for persistence / preservation / writes.
- The workflow literally cannot function otherwise (rare — first-run cost alone is not enough).

When a user asks for something that needs writes to a `ro:` dir ("run the test suite", "install this package"), surface the tradeoff explicitly: "`node_modules` is currently `ro:`; for `npm install` I can switch to `--cp` (copy in, discard on exit) or `--mount` (writes land on your host). Which?"

Full decision matrix with worked examples: `references/artifact-decision.md`.

## Host-write invariant (read this before adding any mount)

The whole point of ccairgap is that the host filesystem cannot be mutated outside a small, explicit set of paths (see SPEC §"Host writable paths"). Every recommendation must respect this:

- `ro` never writes host. Safe default.
- `cp` and `sync` never write the original host path. Safe.
- `mount` **does** write the host path live. Explicit opt-in weakening for one path. Only when the user has said yes and understands the tradeoff.
- Raw `--docker-run-arg "-v <host>:<ctr>:rw"` also writes host. Never recommend this as a way to get a writable path — `--mount <path>` is narrower and structured.
- `--privileged`, `--cap-add SYS_ADMIN`, `--network=host`, `--pid=host`, `--device`, and anything with `docker.sock` **eliminate the isolation this tool provides**. Do not recommend these. If a user asks for one, say so plainly: "that disables the sandbox — is that what you want?" and wait.

When in doubt, pick the less permissive option and tell the user how to upgrade later.

## Secrets and sensitive data

**Default posture: do not touch them.** Don't propose mounting `.env`, `~/.ssh`, `~/.aws`, `~/.gcloud`, browser profiles, password-manager data, keychains, or any file that smells like credentials. Don't propose `-e <API_KEY>` pass-through as part of a "complete" config.

Only configure a secret flow when one of these is true:

- The user explicitly named the secret and asked for it.
- A hook or MCP the user asked to enable genuinely requires a credential to function, and you've told the user which one and how you plan to pass it.

When you do need to wire one in, read `references/secrets-and-sensitive-data.md` first. Never commit a secret to `config.yaml`; use `-e NAME` pass-through (value stays on the host) and tell the user.

## Dockerfile extension rules

Custom Dockerfiles should normally `FROM` the published ccairgap image tag generated by `ccairgap init`. The entrypoint and user setup are inherited from that image, so add only the project-specific packages or files the workflow needs. Key invariants if you replace the base instead of inheriting from it (full details in `references/dockerfile-patterns.md`):

- `/home/claude` must be writable by the runtime UID passed through `docker run --user`.
- Agent mount targets must exist: `/home/claude/.claude/projects`, `/home/claude/.claude/plugins/cache`, `/home/claude/.codex`, and `/home/claude/.codex/sessions`.
- `/usr/local/bin/ccairgap-entrypoint` must exist and remain the entrypoint.
- Both agent CLIs must be installed and on the runtime PATH.

Image tag for custom Dockerfiles is `ccairgap:custom-<sha256(dockerfile)[:12]>` — content-addressed, rebuilds skip automatically when content doesn't change. Force rebuild: `--rebuild`.

## Hook policy cheat sheet

All hooks are disabled by default inside the container — every hook source is overlaid with `hooks: {}`, but `disableAllHooks` is forced to `false` so the user's custom `statusLine` keeps running. Re-enable individual hook commands with globs against the raw `command` string. Anchored full match, `*` is wildcard. Full cookbook in `references/hook-patterns.md`.

Common patterns:

```yaml
hooks:
  enable:
    - "python3 *"                              # any python3 hook
    - "node /path/to/audit.js"                 # exact node command
    - "*/auto-approve.py *"                    # any command ending in auto-approve.py
```

Don't put statusline scripts here — `statusLine` is not a hook in ccairgap's filtering and runs by default. (It will fail silently if its binary deps aren't in the image.)

Important caveat: enabling a hook doesn't guarantee it works — the command's binary must exist inside the container. If the hook shells out to a host-only binary, either install it via the custom Dockerfile or leave the hook disabled.

## MCP policy cheat sheet

All MCP servers are disabled by default inside the container — every source (user `~/.claude.json`, user-project, project `<repo>/.mcp.json`, plugin `.mcp.json` / `plugin.json`) is overlaid with `mcpServers: {}`. Re-enable individual servers with globs against their `name` (the key under `mcpServers`). Anchored full match, `*` is wildcard. Full cookbook in `references/mcp-patterns.md`.

Common patterns:

```yaml
mcp:
  enable:
    - "grafana"                # exact match
    - "playwright"
    - "codex-*"                # any name starting with codex-
```

**Project-scope servers (`<repo>/.mcp.json`) need host approval in addition to the glob.** ccairgap treats the host approval state (`enabledMcpjsonServers` / `enableAllProjectMcpServers` — see `ccairgap inspect` → `approvalState`) as the trust signal; a server approved on host AND matching a glob survives. User-scope and plugin-scope have no such gate.

Caveats:
- **Enabling ≠ working.** The server's binary must be installed in the image (custom Dockerfile) and any required env vars / credentials must pass through (`docker-run-arg: ["-e API_KEY"]`). Same pattern as hooks.
- **MCP servers often need secrets.** See `references/secrets-and-sensitive-data.md` — default is to surface the trade-off and wait, not silently wire secrets through.

## When `docker-run-arg` is *not* the answer

`docker-run-arg` exists for edge cases the CLI doesn't surface as structured flags. The skill's default stance is: **do not propose it**. Most users never need one. Propose a `docker-run-arg` entry *only* when the user has clearly described a need that maps to one, in their own words — not because you inferred it.

Concrete triggers the user must actually say:

- "I need to hit the dev server from my browser" / "expose port X" → then `-p X:X`.
- "It needs to talk to my local Postgres" / "attach to my docker network `foo`" → then `--network foo` or `--add-host`.
- "The MCP needs `$OPENAI_API_KEY`" / names the env var → then `-e OPENAI_API_KEY` pass-through (and see secrets rules).
- "I need more memory for this build" → then `--memory=8g`.

If you catch yourself writing a `docker-run-arg` line because a port *might* be useful, or because you're building a "complete" config, delete it. Full cookbook (for when the user does ask): `references/docker-run-args.md`.

## Artifact decision — which surface?

Use this decision tree; full matrix in `references/artifact-decision.md`.

**Is this a launch flag that already exists?** → put it in `config.yaml`. See `references/config-schema.md`.

**Is this a binary or package the workflow shells out to but isn't in the base image?** → custom `Dockerfile` that `FROM`s the base and adds the binary. See `references/dockerfile-patterns.md`.

**Is this a directory on the host Claude needs to read?** → `ro:`. Escalate per the ladder above only when the user asks.

**Is this a Claude Code hook the user wants active inside the sandbox?** → `--hook-enable '<glob>'` matched against the hook's `command` string. All hooks disabled by default. See `references/hook-patterns.md`.

**Is this a Claude Code MCP server the user wants active inside the sandbox?** → `--mcp-enable '<glob>'` matched against the MCP server `name`. All MCPs disabled by default. Project-scope `<repo>/.mcp.json` servers also need host approval. See `references/mcp-patterns.md`.

**Is it anything else (ports, networks, env vars, exotic mount options)?** → probably don't propose it. If the user has explicitly asked, see `references/docker-run-args.md`.

## Assets

Use these as starting points, don't copy them verbatim. Strip every key the user doesn't need; keep comments that justify what's left.

- `assets/config.yaml.template` — annotated skeleton. Everything beyond `repo` is commented out; uncomment only the keys you're actually using.
- `assets/Dockerfile.template` — minimal `FROM ghcr.io/alfredvc/ccairgap:<tag>` skeleton. Add only the project-specific `RUN`/`COPY` lines the user needs.

## Reference files

Read only what you need.

| File | Read when |
|------|-----------|
| `references/gathering-context.md` | Always, during Phase 1 — the probe checklist. |
| `references/config-schema.md` | User asks about any config key, precedence, or where relative paths resolve. |
| `references/dockerfile-patterns.md` | User needs Python / Playwright / Rust / any non-default binary. |
| `references/artifact-decision.md` | User has asked to cache or preserve a directory (`node_modules`, `target`, `dist`, etc.). |
| `references/hook-patterns.md` | Enabling hooks, understanding which get disabled. |
| `references/mcp-patterns.md` | Enabling MCP servers, understanding the host-approval gate for project-scope. |
| `references/secrets-and-sensitive-data.md` | User has explicitly asked to wire in a credential or env var. |
| `references/docker-run-args.md` | User has explicitly asked for something that requires raw docker args (port, network, env, resource limits). |

## Common traps

- **Don't put host-absolute paths in committed `config.yaml`.** Use relative paths. Three anchors: `repo`/`extra-repo`/`ro` resolve against the **git root** (parent of the config dir — works for both `.ccairgap/` and `.config/ccairgap/`). `dockerfile` resolves against the **config file's directory** (sidecar, so `dockerfile: Dockerfile` finds the Dockerfile next to the config). `cp`/`sync`/`mount` resolve against the **workspace repo root** at launch. Absolute paths work but don't transfer between teammates.
- **Don't recommend `--privileged`, `--cap-add`, `--pid=host`, `--network=host`, or `docker.sock` mounts to "make it work".** Those defeat the sandbox. Diagnose the root cause; if the honest answer is "this workflow can't run sandboxed", say so.
- **Don't default to RW mounts for artifact dirs.** `node_modules`, `.venv`, `target/` get no config entry unless the user asks to cache them. First-run cost is not an escalation trigger.
- **Don't replace the published base image unless you need to.** Inheriting from `ghcr.io/alfredvc/ccairgap:<tag>` preserves UID portability, entrypoint behavior, agent CLIs, and mount targets. Replacement Dockerfiles must reimplement those invariants.
- **Don't mount `~/.claude/` RW.** It's RO by design — session mutations die with the container. Users asking to persist these are usually asking the wrong question; talk them through it.
- **Don't confuse `--cp` with Docker's `COPY`.** `--cp` is a pre-launch rsync from host to session scratch; container sees it RW at the same absolute path; changes discarded on exit.
- **Don't add config keys that don't exist in SPEC.** The validator rejects unknown keys. If the user asks for a new behavior not in `docs/SPEC.md`, tell them — adding flags is a SPEC change, not a config-file workaround.
- **Don't ship a "full" config or Dockerfile as a default.** The artifacts you emit should contain only the keys and `RUN` lines the user's workflow actually needs. Extra lines confuse; extra mounts leak.
