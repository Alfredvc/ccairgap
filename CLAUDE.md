# ccairgap

CLI that runs `claude --dangerously-skip-permissions` inside a Docker container so host FS cannot be mutated outside a small writable set. Full design: `docs/SPEC.md`. User-facing overview: `README.md`. Per-topic user docs under `docs/` (config, hooks, mcp, dockerfile, docker-run-args, clipboard, auto-memory, managed-policy). Keep those authoritative — update them when behavior changes; don't duplicate their content here.

## Stack

- TypeScript, ESM, Node ≥ 20. Bundled via **tsup** to single `dist/cli.js` (see `tsup.config.ts`).
- Deps: `commander` (args), `execa` (shell out to `docker`/`git`/`claude`), `yaml` (config file), `shell-quote` (tokenize `--docker-run-arg`), `proper-lockfile` (coordinate host auth refresh with host-native `claude` and peer ccairgap launches). No runtime config libs beyond that.
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

## Testing

- Unit tests: `src/*.test.ts`, colocated, mock `execa`/`fs`/`docker`. Run via `npm test`.
- E2e tests: `e2e/**/*.e2e.ts`, manual-run via `npm run test:e2e`. Tier 1 (no docker) covers subcommands + config + resume resolution. Tier 2 (docker, fake entrypoint via `CCAIRGAP_TEST_CMD`) covers launch, handoff, mounts, alternates, signals, image hashing, artifacts. **E2e is never wired into CI.**
- Real-claude smoke: `bash e2e/smoke.sh`. Human-eyeballed. Run before tagging a release.

## Layout

```
src/
  cli.ts          commander entry; arg parse, config merge, dispatch
  cliSplit.ts     pre-split process.argv at first bare `--` for claude-args passthrough; rejects on subcommand
  claudeArgs.ts   denylist + tokenizer for `claude` passthrough (CLI `--` tail + config `claude-args:`)
  config.ts       YAML config load + CLI-vs-config merge (CLI > config > defaults)
  launch.ts       main launch pipeline: clone, mounts, docker run, exit trap
  subcommands.ts  list / recover / discard / doctor / inspect / init
  handoff.ts      exit trap + recover logic (git fetch sandbox branch, copy transcripts, rm session)
  resume.ts       --resume: pre-launch validation + copy of host `~/.claude/projects/<encoded>/<uuid>.jsonl` into $SESSION/transcripts/. UUID only — name→UUID resolution lives in resumeResolver.ts.
  resumeResolver.ts --resume <id-or-name>: UUID regex passthrough; otherwise head+tail 64KiB scan of workspace transcripts for exact customTitle match (case-insensitive, Claude Code semantics).
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
  credentials.ts  Read host creds (macOS keychain / Linux file), run `refreshIfLowTtl`, strip `claudeAiOauth.refreshToken`, write to $SESSION/creds/.credentials.json (0600). Uniform on both platforms. Throws `CredentialsDeadError` on hard-failure.
  authRefresh.ts  `refreshIfLowTtl`: proper-lockfile on host ~/.claude/, invoke `claude auth login` with OAuth env vars, classify outcome (revoked / network / binary-missing / timeout / unknown), return authoritative post-attempt JSON + ttl.
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
- **Creds path is uniform across OS.** Both macOS and Linux materialize `$SESSION/creds/.credentials.json` (0600) as a **modified** copy of host creds with `claudeAiOauth.refreshToken` deleted. The session file is bind-mounted at `/host-claude-creds`. Never add a code path that bind-mounts host `~/.claude/.credentials.json` directly or writes the raw host JSON into the session file — the container must never see a refresh token (prevents cross-container 401 races; see `docs/SPEC.md §"Authentication flow"`).
- **Pre-launch auth refresh is lock-coordinated.** `resolveCredentials` delegates to `refreshIfLowTtl` (src/authRefresh.ts), which acquires a `proper-lockfile` on host `~/.claude/` — the same library and path Claude Code uses at `src/utils/auth.ts:1491` upstream. Refresh invokes `claude auth login` with `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` (upstream `src/cli/handlers/auth.ts:140-186`), stdin ignored, 120s timeout. Do not replace this with a direct HTTP refresh call — the fast-path is the only supported surface that keeps write-back to keychain / file-storage in lockstep with host-native `claude`. `CredentialsDeadError` fires when refresh fails AND final ttl < 5 min, before any session dir is materialized; the 5-min floor matches Claude Code's own `isOAuthTokenExpired` buffer (`auth.ts:344-353`).
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
- **`--resume` validation runs before `mkdirSync($SESSION)`.** `resolveResumeArg` (name→UUID) then `resolveResumeSource` (UUID → transcript paths) are both called in the validation phase so a bad name/UUID exits 1 with no session dir created. The side-effect phase then calls `copyResumeTranscript` with the pre-resolved source. Do not fold these back into one helper — the split is what preserves the "exit 1 before side effects" spec guarantee. `CCAIRGAP_RESUME` carries the resolved UUID (not the raw arg) — the `<uuid>.jsonl` file is the only transcript copied into `$SESSION/transcripts/`, so only the UUID form is guaranteed to resolve in-container.
- **Clipboard watcher is a child of the CLI process.** Host-side watcher (osascript on macOS; wl-paste/xclip on Linux) is spawned by `detectAndSetupClipboardBridge` with `detached: false`, so Ctrl-C and SIGKILL of the CLI kill the watcher automatically (same process group). Graceful cleanup via `clipboard.cleanup()` uses SIGTERM → 500 ms grace → SIGKILL, awaited in `launch.ts`'s `finally` block BEFORE handoff. Mid-session watcher crash is handled by a `child.on("exit")` handler that removes the bridge file so Claude Code doesn't paste a stale image (SIGTERM/SIGINT/SIGHUP are filtered out — those mean "normal exit" and don't warrant a warning). **Invariant: `xclip` and `wl-clipboard` must not end up in the container image** — Claude Code tries `xclip` before `wl-paste`, so either binary's presence breaks the fake-shim override. Enforced by `src/dockerfileInvariants.test.ts` + a runtime stderr warning in the entrypoint.
- **Handoff preserves session dir on dirty working tree or scan failure.** `handoff()` treats any `git status --porcelain` non-empty output (per-repo) **or** any scan error as a preservation trigger, in addition to the existing orphan-branch logic. The final `rm -rf` is gated on all three conditions being absent. The dirty scan runs **after** the alternates rewrite in the per-repo loop — both steps must stay in that order across refactors. Applies to both exit-trap and `ccairgap recover` paths; `--no-preserve-dirty` / config key `no-preserve-dirty: true` suppresses the dirty trigger for scripted callers — the scan still runs so scan-failure and orphan preservation can fire.
- **Project-scope Claude config overlay is working-tree, not HEAD, and allowlisted under `.claude/`.** `overlayProjectClaudeConfig` rsyncs an allowlist of host subpaths into each session clone after `gitCheckoutNewBranch`, before `applyHookPolicy` / `applyMcpPolicy` / `executeCopies`: `.claude/{settings.json,settings.local.json,commands,agents,skills,hooks}`, `.mcp.json`, `CLAUDE.md`. Covers the common gap where `settings.local.json` (gitignored by default) and uncommitted project skills/commands/agents never reach the container. Allowlist (not whole `.claude/`) because users park non-Claude data under `.claude/` — worktrees, build caches, logs — that can run to multi-GB and stall the overlay. Grow `PROJECT_CLAUDE_ALLOWLIST` in `src/projectClaudeOverlay.ts` when Claude Code ships a new project-scope subpath. Paired invariant: `dirtyTree` pathspec-excludes `.claude` / `.mcp.json` / `CLAUDE.md` wholesale — deliberately a **superset** of the overlay allowlist, so overlay-introduced uncommitted state doesn't trigger preservation **and** container-side writes to non-overlaid `.claude/*` paths (plugin install, etc.) are also discarded on exit. The dirtyTree exclude must stay a superset; narrowing it would flip those non-overlaid writes into preservation triggers. rsync `-L` materializes symlinks so `CLAUDE.md → AGENTS.md` and out-of-repo skill symlinks work without special casing.
- **`recover <id>` refuses to run against a live container.** Pre-handoff check uses the shared `runningContainerNames()` helper (`src/sessionId.ts`) — same probe as `ccairgap list`. If `ccairgap-<id>` is in the running set, abort with a message telling the user to `docker stop` or let the session exit normally. Required because the dirty scan and (existing) `git fetch` would race with container writes.
- **`CCAIRGAP_TEST_CMD` is a test-only backdoor in `entrypoint.sh`.** When set, the entrypoint `exec sh -c "$CCAIRGAP_TEST_CMD"` instead of `exec claude …`. The CLI never sets it; only e2e tests do, via `--docker-run-arg`. Do not add CLI-surfaced plumbing that sets this variable — the whole point is that production paths never touch it.
- **Claude flag passthrough is denylist-gated, not allowlist-gated.** `src/claudeArgs.ts` owns the denylist (ccairgap-owned flags, resume-family, sandbox-incompatible host paths / policy bypass, pointless-in-container, soft-drop no-ops). Everything else passes through unchanged so new Claude Code flags work the day they ship. CLI `--` tail and `claude-args:` config key are merged (config first, CLI appended) and filtered in one pass; the filtered list is appended as positional args to `docker run`, which forwards them to the entrypoint as `"$@"`, which splices `"$@"` into the `exec claude` line between the resume args and `-p`. Argv forwarding (not env-var JSON) avoids serialization layers and the per-env-var size cap. Entrypoint does **not** re-validate — the CLI is the trust boundary, not the image. Users who run the image directly via `docker run` can set any args (no claim otherwise; the image is not a security boundary). Denylist changes live in one place (`src/claudeArgs.ts`); the value-taking-flag table also lives there and must grow when a new value-taking allowed flag lands (otherwise the next token would be re-classified as a flag and a denied-adjacent token would fire a false-positive deny).
- **`--` passthrough is reserved for the default launch command.** `src/cliSplit.ts` pre-splits `process.argv` at the first bare `--` before handing it to commander. When the leading positional is a known subcommand (`list`, `recover`, `discard`, `doctor`, `inspect`, `init`), the pre-split errors out ("`--` passthrough is only valid on the default launch command"). The existing `preAction` unknown-command guard still fires on real typos like `ccairgap lsit` because `lsit` stays in the pre-split argv. Changing this pre-split requires matching updates to the preAction guard and the subcommand enumeration. The pre-split helper lives in its own module so unit tests can import it without triggering `cli.ts`'s top-level `main()` invocation.
- **Auto-memory is RO via env-var redirect.** Host auto-memory dir (resolved per Claude Code's `autoMemoryDirectory` cascade — see `docs/SPEC.md` §"Auto-memory") is bind-mounted RO at `/host-claude-memory` and Claude Code is redirected to it via `-e CLAUDE_COWORK_MEMORY_PATH_OVERRIDE=/host-claude-memory`. Do not nest the mount under `~/.claude/projects/` (Docker Desktop nested-bind regression + handoff copy-back would silently propagate writes back to host, breaking the "host writable paths closed set" invariant). Do not inject `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` — that kills reads too. Use `--no-auto-memory` for the user-facing kill switch. Writes fail EROFS and are swallowed by Claude Code's callers.
- **Entrypoint appends a bypass-immune-paths warning to `~/.claude/CLAUDE.md`.** Claude Code's upstream safety gate (`permissions.ts` step 1g + `checkPathSafetyForAutoEdit` in `filesystem.ts`) ignores `--dangerously-skip-permissions` for a hardcoded set of paths (`DANGEROUS_DIRECTORIES`, `DANGEROUS_FILES`, `isClaudeSettingsPath`, `.claude/{commands,agents,skills}/**`) and fires an interactive prompt the sandbox cannot answer. Settings-scope allow rules do **not** bypass this gate (only `.claude/**` session-scope rules do, per `filesystem.ts:1252-1299`). The baked-in `~/.claude/CLAUDE.md` append warns the in-session model about the consequence; the note is advisory, not prohibitive. Appended unconditionally, after the `.ccairgap/CLAUDE.md` user overlay so it is always the last block. Grow the listed paths in `docker/entrypoint.sh` when upstream's `DANGEROUS_DIRECTORIES` / `DANGEROUS_FILES` / safety carve-outs change. See `docs/SPEC.md` §"Entrypoint" step 9.
- **Managed-policy uses cross-OS path translation on macOS.** Host macOS path `/Library/Application Support/ClaudeCode/` is RO-mounted at Linux container path `/etc/claude-code/`. On Linux hosts the path is the same on both sides (no translation). Explicit exception to absolute-path preservation; same precedent as credentials (`/host-claude-creds`). Skipped when the host dir is absent or when the host is Windows — no MDM forwarding on Windows hosts (documented as out-of-scope in the README, consistent with ccairgap's existing POSIX-only assumptions from `rsync`/`cp`/`chmod`).

## Config file & env vars

User-facing config and env-var reference lives in [docs/config.md](docs/config.md) and `README.md` §"Environment variables". Dev-only implementation anchors: `resolveConfigPaths` in `src/config.ts` + `src/artifacts.ts` implement the three path anchors; profile anchor logic depends on basename of config dir (`.ccairgap` / `.config/ccairgap`).

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
