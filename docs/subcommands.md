# Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List orphaned sessions on disk. |
| `recover [<id>]` | Run handoff (fetch sandbox branch, copy transcripts, rm session dir if clean). Idempotent. Preserves session on dirty tree, orphan-branch commits, or scan failure — commit or discard the work, then re-run. Aborts if the container is still running; stop it first. With no `<id>`, falls back to `list`. |
| `discard <id>` | Delete a session dir without running handoff. |
| `doctor` | Preflight checks: Docker running, credentials present, image present/stale, state dir writable, `git` + `rsync` + `cp` on PATH. Hash-compares any sidecar `Dockerfile` / `entrypoint.sh` against the bundled copies and warns on drift — useful after a CLI upgrade. |
| `init` | Scaffold `.ccairgap/{Dockerfile, entrypoint.sh, config.yaml}`. Fails if any file exists; `--force` overwrites. |
| `inspect` | Dump every hook, MCP server, env var, and marketplace mount the container would see at launch. JSON to stdout; `--pretty` for tables. Read-only. |
| `install-completion [<shell>]` | Install shell tab-completion (bash/zsh/fish). Writes one source line into your shell rc via `@pnpm/tabtab`. Completion covers subcommand names, launch flags, and dynamic candidates: session ids for `recover` / `discard`, custom titles for `-r` / `--resume`, shell names for `install-completion`. Omit `<shell>` to be prompted. |
| `uninstall-completion` | Remove ccairgap completion from every supported shell rc. Idempotent. |
