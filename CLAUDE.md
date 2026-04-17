# claude-airlock

CLI that runs `claude --dangerously-skip-permissions` inside a Docker container so host FS cannot be mutated outside a small writable set. Full design: `docs/SPEC.md`. User-facing overview: `README.md`. Keep those two authoritative — update them when behavior changes.

## Stack

- TypeScript, ESM, Node ≥ 20. Bundled via **tsup** to single `dist/cli.js` (see `tsup.config.ts`).
- Deps: `commander` (args), `execa` (shell out to `docker`/`git`), `yaml` (config file). No runtime config libs beyond that.
- Tests: **vitest** (`*.test.ts` colocated in `src/`). Type check: `tsc --noEmit`.
- Distribution: npm `claude-airlock`, bin → `dist/cli.js`. `files`: `dist`, `docker`, `README.md`, `LICENSE`.

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
  subcommands.ts  list / recover / discard / doctor
  handoff.ts      exit trap + recover logic (git fetch sandbox branch, copy transcripts, rm session)
  manifest.ts     $SESSION/manifest.json read/write; carries "version": 1
  orphans.ts      scan $XDG_STATE_HOME for sessions without live container
  git.ts          resolve real git dir (dir / file-worktree), clone --shared, branch
  alternates.ts   rewrite .git/objects/info/alternates to /host-git-alternates/<name>/objects
  mounts.ts       build docker -v list per SPEC §Container mount manifest
  plugins.ts      jq-equivalent scan of settings.json extraKnownMarketplaces
  credentials.ts  macOS: `security find-generic-password -s "Claude Code-credentials"` → $SESSION/creds. Linux: verify ~/.claude/.credentials.json exists.
  image.ts        docker build; tag = claude-airlock:<cli-version> or :custom-<sha256(dockerfile)[:12]>
  paths.ts        XDG state dir resolution; CLAUDE_AIRLOCK_HOME override
  version.ts      cliVersion() from package.json
docker/
  Dockerfile      node:20-slim; claude-code@${CLAUDE_CODE_VERSION:-latest}; non-root `claude` at HOST_UID/HOST_GID
  entrypoint.sh   rsync /host-claude → ~/.claude, copy creds, patch .claude.json, exec claude
docs/SPEC.md      authoritative design
```

## Non-obvious invariants

- **Host writable paths are closed set** (SPEC §"Host writable paths"): session scratch, `output/`, `~/.claude/projects/<encoded>`, and `sandbox/<ts>` ref via `git fetch` on exit. Adding any other write path requires SPEC update.
- **Container never writes host repo directly.** Exit handoff runs `git fetch` on the host against `$SESSION/repos/<name>`. Don't add a flow where the container has RW on real repos.
- **Alternates rewrite is required.** `git clone --shared` writes the host absolute path; that path is meaningless in-container. Mounting host `objects/` over `<hostPath>/.git/objects/` would shadow the session clone's RW objects. Mount at neutral `/host-git-alternates/<name>/objects/` and rewrite `alternates` file host-side.
- **Absolute paths are preserved host↔container** so `settings.json`, marketplace refs, and transcript encoded dirs resolve identically.
- **Creds path differs by OS.** macOS: materialize keychain item to `$SESSION/creds/.credentials.json` (0600). Linux: bind-mount `~/.claude/.credentials.json` directly. Both surface as `/host-claude-creds`.
- **`/host-claude` RO mount excludes `.credentials.json`** — creds flow solely via `/host-claude-creds` to keep entrypoint uniform.
- **`rsync -rL`** in entrypoint materializes symlinks as files. Exclude session-local dirs (`projects/`, `sessions/`, `history.jsonl`, `todos/`, `shell-snapshots/`, `debug/`, `paste-cache/`, `session-env/`, `file-history/`), `plugins/cache/` (RO-mounted separately), `.credentials.json`, `.DS_Store`.
- **Image tag = CLI version**, or `custom-<hash>` when `--dockerfile`. Rebuild only on: tag missing / `--rebuild` / custom-hash changed. Never auto-rebuild on age — `doctor` warns >14 days.
- **Manifest `version` field gates handoff.** Bump when shape changes incompatibly. Handoff aborts with clear error on unknown version.
- **Flag names + subcommand names are public API.** Rename = major bump.
- **Exit trap is best-effort.** SIGKILL of CLI leaves session on disk; user runs `claude-airlock recover <ts>`. Handoff must stay idempotent.
- **`--cap-drop=ALL`, no `--privileged`, no `docker.sock` mount, no `SYS_ADMIN`.** Don't lower default Docker isolation.

## Config file

`--config <path>` or default `<git-root>/.claude-airgap/config.yaml`. YAML. Both kebab-case and camelCase keys accepted. Precedence: CLI > config > defaults. Scalars: CLI wins. Arrays (`extra-repo`, `ro`): concat (config first, CLI appended). Maps (`docker-build-arg`): per-key merge, CLI wins. Relative paths resolve against config file's directory. Unknown keys + wrong types → error.

## Host env vars

- `CLAUDE_AIRLOCK_HOME` — override state dir root. Default `$XDG_STATE_HOME/claude-airlock/`.
- `CLAUDE_AIRLOCK_CC_VERSION` — short-form for `--docker-build-arg CLAUDE_CODE_VERSION=<val>`.

## When adding features

1. Update `docs/SPEC.md` first if behavior or contract changes.
2. Update `README.md` for user-facing flags/env/subcommands.
3. Keep runtime deps minimal. No new deps without reason.
4. Don't bypass SPEC §"Host writable paths". If a new write target is needed, discuss before coding.
5. Don't add flags/env vars not in SPEC. If truly needed, add to SPEC first.
