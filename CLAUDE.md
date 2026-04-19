# ccairgap

CLI that runs `claude --dangerously-skip-permissions` inside a Docker container so host FS cannot be mutated outside a small writable set. Full design: `docs/SPEC.md`. User-facing overview: `README.md`. Keep those two authoritative — update them when behavior changes.

## Stack

- TypeScript, ESM, Node ≥ 20. Bundled via **tsup** to single `dist/cli.js` (see `tsup.config.ts`).
- Deps: `commander` (args), `execa` (shell out to `docker`/`git`), `yaml` (config file), `shell-quote` (tokenize `--docker-run-arg`). No runtime config libs beyond that.
- Tests: **vitest** (`*.test.ts` colocated in `src/`). Type check: `tsc --noEmit`.
- Distribution: npm `ccairgap`, bin → `dist/cli.js`. `files`: `dist`, `docker`, `README.md`, `LICENSE`, `SECURITY.md`.

## Scripts

```
npm run build        # tsup bundle
npm run dev          # tsup --watch
npm run typecheck    # tsc --noEmit
npm test             # vitest run
npm run test:watch
```

## Layout

```
src/
  cli.ts          commander entry; arg parse, config merge, dispatch
  config.ts       YAML config load + CLI-vs-config merge (CLI > config > defaults)
  launch.ts       main launch pipeline: clone, mounts, docker run, exit trap
  subcommands.ts  list / recover / discard / doctor / inspect / init
  handoff.ts      exit trap + recover logic (git fetch sandbox branch, copy transcripts, rm session)
  resume.ts       --resume <uuid>: pre-launch copy of host `~/.claude/projects/<encoded>/<uuid>.jsonl` into $SESSION/transcripts/, + latest-agent-name extraction.
  manifest.ts     $SESSION/manifest.json read/write; carries "version": 1
  orphans.ts      scan $XDG_STATE_HOME for sessions without live container
  git.ts          resolve real git dir (dir / file-worktree), clone --shared, branch
  alternates.ts   rewrite .git/objects/info/alternates to /host-git-alternates/<name>/objects
  mounts.ts       build docker -v list per SPEC §Container mount manifest
  artifacts.ts    --cp/--sync/--mount path resolution + pre-launch rsync + exit copy-out
  binaries.ts     host-binary preflight (docker/git/rsync/cp on PATH)
  dockerRunArgs.ts --docker-run-arg tokenization (shell-quote) + dangerous-arg scanner
  hooks.ts        enumerate + filter hook entries across user/plugin/project sources
  mcp.ts          enumerate MCP server definitions across user/project/plugin sources
  settings.ts     settings.json read-only enumeration: env vars + extraKnownMarketplaces
  inspectFormat.ts pretty-print tables for `ccairgap inspect --pretty`
  plugins.ts      plugin marketplace directory/file-source discovery
  credentials.ts  macOS: `security find-generic-password -s "Claude Code-credentials"` → $SESSION/creds. Linux: verify ~/.claude/.credentials.json exists.
  image.ts        docker build; tag = ccairgap:<cli-version>-<sha256(Dockerfile+entrypoint.sh)[:8]> or :custom-<sha256(dockerfile)[:12]>
  paths.ts        XDG state dir resolution; CCAIRGAP_HOME override
  version.ts      cliVersion() from package.json
docker/
  Dockerfile      node:20-slim; native installer (claude.ai/install.sh) pinned to ${CLAUDE_CODE_VERSION} (default: host version); non-root `claude` at HOST_UID/HOST_GID
  entrypoint.sh   rsync /host-claude → ~/.claude, copy creds, patch .claude.json, exec claude
docs/SPEC.md      authoritative design
```

## Non-obvious invariants

- **Host writable paths are closed set** (SPEC §"Host writable paths"): session scratch, `output/`, `~/.claude/projects/<encoded>`, `ccairgap/<id>` ref via `git fetch` on exit, and `$SESSION/clipboard-bridge/` (populated by the host-side clipboard watcher when passthrough is active). Adding any other write path requires SPEC update.
- **Container never writes host repo directly.** Exit handoff runs `git fetch` on the host against `$SESSION/repos/<name>`. Don't add a flow where the container has RW on real repos.
- **Alternates rewrite is required.** `git clone --shared` writes the host absolute path; that path is meaningless in-container. Mounting host `objects/` over `<hostPath>/.git/objects/` would shadow the session clone's RW objects. Mount at neutral `/host-git-alternates/<name>/objects/` and rewrite `alternates` file host-side.
- **Absolute paths are preserved host↔container** so `settings.json`, marketplace refs, and transcript encoded dirs resolve identically.
- **Creds path differs by OS.** macOS: materialize keychain item to `$SESSION/creds/.credentials.json` (0600). Linux: bind-mount `~/.claude/.credentials.json` directly. Both surface as `/host-claude-creds`.
- **`/host-claude` RO mount excludes `.credentials.json`** — creds flow solely via `/host-claude-creds` to keep entrypoint uniform.
- **Host-abs-path plugins mount is required.** `known_marketplaces.json.installLocation` and `installed_plugins.json.installPath` store absolute host paths. The container-$HOME `plugins/cache` RO mount alone isn't enough — Claude Code's marketplace resolver stat()s the host-abs path literally. `buildMounts` adds a second RO mount of `~/.claude/plugins/` at its real host absolute path; skipped only when host `~/.claude` coincides with container `$HOME/.claude`.
- **`rsync -rL`** in entrypoint materializes symlinks as files. Exclude session-local dirs (`projects/`, `sessions/`, `history.jsonl`, `todos/`, `shell-snapshots/`, `debug/`, `paste-cache/`, `session-env/`, `file-history/`), `plugins/cache/` (RO-mounted separately), `.credentials.json`, `.DS_Store`.
- **Image tag = CLI version + content hash of `Dockerfile`+`entrypoint.sh`** (`ccairgap:<cli-version>-<hash8>`), or `custom-<hash>` when `--dockerfile`. Edits to either baked file produce a new tag, so rebuild-on-miss auto-applies changes. Rebuild triggers: tag missing / `--rebuild` / custom-hash changed. Never auto-rebuild on age — `doctor` warns >14 days. Old `<cli-version>-*` tags linger after upgrades; `doctor` lists them and users prune via `docker image rm`.
- **Manifest `version` field gates handoff.** Bump when shape changes incompatibly. Handoff aborts with clear error on unknown version.
- **Flag names + subcommand names are public API.** Rename = major bump.
- **Exit trap is best-effort.** SIGKILL of CLI leaves session on disk; user runs `ccairgap recover <id>`. Handoff must stay idempotent.
- **`--cap-drop=ALL`, no `--privileged`, no `docker.sock` mount, no `SYS_ADMIN`** in built-in args. Don't lower default Docker isolation in the CLI's own invocation. Users can opt into any docker flag via `--docker-run-arg` — that's a user-foot-gun escape hatch, not a defense claim. Appended after built-ins so last-wins overrides work.
- **Mount list is deduped before `docker run`.** `buildMounts` ends with a `resolveMountCollisions` pass that errors on any exact `dst` collision and on any user-sourced mount using a reserved container path (`/output`, `/host-claude*`, `<home>/.claude/projects|plugins/cache`, under `/host-git-alternates/`, under `/run/ccairgap-clipboard/` (clipboard bridge dir)). The earlier `filterSubsumedMarketplaces` pre-filter drops plugin marketplaces that the workspace repo already covers — kept separate so resolveArtifacts's overlap check never sees the marketplace==repo case.
- **Per-repo scratch paths use `alternatesName = <basename>-<sha256(hostPath)[:8]>`**, not bare `<basename>`. Required for multi-repo sessions with same-basename paths. Applies to `$SESSION/repos/`, `/host-git-alternates/`, and `$SESSION/policy/…/projects/`. Keep `launch.ts` (RepoPlan construction), `mounts.ts` (alternates mount), and `hooks.ts`/`mcp.ts` (policy scratch dir) in sync via the shared `alternatesName` field.
- **Symlinks in `--repo`/`--extra-repo`/`--ro` resolve via `realpath()` before the overlap check** (`validateRepoRoOverlap` in `launch.ts`). `resolve()` is insufficient — it does not follow symlinks, which was how two instances of the same real repo (one symlinked, one direct) used to bypass the duplicate guard.
- **`CCAIRGAP_NAME` is always the session id.** `launch.ts` emits `-e CCAIRGAP_NAME=${id}` unconditionally. The entrypoint builds `claude -n "ccairgap $CCAIRGAP_NAME"` and the UserPromptSubmit rename hook emits `[ccairgap] $CCAIRGAP_NAME`; the two strings differ so Claude's hook-dedup fires and the TUI rename paints. Resume flows reuse the new id — prior display name is not preserved (see `docs/SPEC.md` §"Build claude args"). The title hook emits via `jq -nc --arg title …` — raw `printf` would break on future id shapes containing a quote or backslash.
- **`--resume` validation runs before `mkdirSync($SESSION)`.** `resolveResumeSource` is called in the validation phase so a missing `<uuid>.jsonl` exits 1 with no session dir created. The side-effect phase then calls `copyResumeTranscript` with the pre-resolved source. Do not fold these back into one helper — the split is what preserves the "exit 1 before side effects" spec guarantee.
- **Clipboard watcher is a child of the CLI process.** Host-side watcher (osascript on macOS; wl-paste/xclip on Linux) is spawned by `detectAndSetupClipboardBridge` with `detached: false`, so Ctrl-C and SIGKILL of the CLI kill the watcher automatically (same process group). Graceful cleanup via `clipboard.cleanup()` uses SIGTERM → 500 ms grace → SIGKILL, awaited in `launch.ts`'s `finally` block BEFORE handoff. Mid-session watcher crash is handled by a `child.on("exit")` handler that removes the bridge file so Claude Code doesn't paste a stale image (SIGTERM/SIGINT/SIGHUP are filtered out — those mean "normal exit" and don't warrant a warning). **Invariant: `xclip` and `wl-clipboard` must not end up in the container image** — Claude Code tries `xclip` before `wl-paste`, so either binary's presence breaks the fake-shim override. Enforced by `src/dockerfileInvariants.test.ts` + a runtime stderr warning in the entrypoint.
- **Handoff preserves session dir on dirty working tree or scan failure.** `handoff()` treats any `git status --porcelain` non-empty output (per-repo) **or** any scan error as a preservation trigger, in addition to the existing orphan-branch logic. The final `rm -rf` is gated on all three conditions being absent. The dirty scan runs **after** the alternates rewrite in the per-repo loop — both steps must stay in that order across refactors. Applies to both exit-trap and `ccairgap recover` paths; `--no-preserve-dirty` / config key `no-preserve-dirty: true` suppresses the dirty trigger for scripted callers — the scan still runs so scan-failure and orphan preservation can fire.
- **`recover <id>` refuses to run against a live container.** Pre-handoff check uses the shared `runningContainerNames()` helper (`src/sessionId.ts`) — same probe as `ccairgap list`. If `ccairgap-<id>` is in the running set, abort with a message telling the user to `docker stop` or let the session exit normally. Required because the dirty scan and (existing) `git fetch` would race with container writes.

## Config file

`--config <path>` or default `<git-root>/.ccairgap/config.yaml` (fallback `<git-root>/.config/ccairgap/config.yaml`). YAML. Both kebab-case and camelCase keys accepted. Precedence: CLI > config > defaults. Scalars: CLI wins. Arrays (`extra-repo`, `ro`): concat (config first, CLI appended). Maps (`docker-build-arg`): per-key merge, CLI wins. Unknown keys + wrong types → error.

**Profiles** — `--profile <name>` picks `<name>.config.yaml` under the canonical dir (or `config.yaml` for `--profile default`). Missing profile file is a hard error (unlike the silent default-walk fallback). Mutex with `--config`. Profile name regex: `[A-Za-z0-9._-]+`. No inheritance; filename lookup only. Anchor logic in `resolveConfigPaths` depends on basename of config dir (`.ccairgap` / `.config/ccairgap`), so profile files get identical workspace-anchor treatment.

**Relative path resolution** — three anchors by semantic (implemented in `src/config.ts` `resolveConfigPaths` + `src/artifacts.ts`):
- `repo`, `extra-repo`, `ro` → **workspace anchor**: git root when config is at either canonical location (`<git-root>/.ccairgap/config.yaml` or `<git-root>/.config/ccairgap/config.yaml`); falls back to `configDir` otherwise. So `repo: .` = git root, `ro: ../docs` = sibling of git root.
- `dockerfile` → **config file's directory** (sidecar convention). `dockerfile: Dockerfile` = `.ccairgap/Dockerfile`.
- `cp`, `sync`, `mount` → **workspace repo root** at launch (`artifacts.ts`, not `resolveConfigPaths`).

Absolute paths bypass anchoring. `repo` is optional; defaults to the git root that contains the config (or cwd).

## Host env vars

- `CCAIRGAP_HOME` — override state dir root. Default `$XDG_STATE_HOME/ccairgap/`.
- `CCAIRGAP_CC_VERSION` — short-form for `--docker-build-arg CLAUDE_CODE_VERSION=<val>`.

## When adding features

1. Update `docs/SPEC.md` first if behavior or contract changes.
2. Update `README.md` for user-facing flags/env/subcommands.
3. Keep runtime deps minimal. No new deps without reason.
4. Don't bypass SPEC §"Host writable paths". If a new write target is needed, discuss before coding.
5. Don't add flags/env vars not in SPEC. If truly needed, add to SPEC first.

## Releasing

Local-driven, cargo-release style. Conventional Commits (`feat:`, `fix:`, `perf:`, `refactor:`, `feat!:` for breaking) drive versioning + CHANGELOG.

```
npm run release           # auto bump (feat→minor, fix→patch, ! → minor pre-1.0)
npm run release -- --release-as minor    # force minor
npm run release -- --release-as 1.0.0    # force exact version
npm run release -- --dry-run             # preview
git push --follow-tags origin main       # triggers .github/workflows/release.yml → npm publish
```

`commit-and-tag-version`: runs typecheck+test, regenerates `CHANGELOG.md`, bumps `package.json`, commits, tags `vX.Y.Z`. Don't bump version or edit CHANGELOG manually.

Config: `.versionrc.json` (sections shown: feat/fix/perf/refactor; hidden: docs/chore/test/style/ci/build).

Pre-1.0: breaking commits (`feat!:`) bump minor, not major. Going to 1.0.0 → run `npm run release -- --release-as 1.0.0` once.
