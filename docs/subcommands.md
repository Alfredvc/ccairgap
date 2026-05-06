# Subcommands

| Subcommand | Description |
|------------|-------------|
| `list` | List orphaned sessions on disk. |
| `recover [<id>]` | Run handoff (fetch sandbox branch, copy transcripts, rm session dir if clean). Idempotent. Preserves session on dirty tree, orphan-branch commits, or scan failure — commit or discard the work, then re-run. Aborts if the container is still running; stop it first. With no `<id>`, falls back to `list`. |
| `discard <id>` | Delete a session dir without running handoff. |
| `attach <id>` | **Advanced.** Spawn a second interactive `claude` inside the running container `ccairgap-<id>` via `docker exec`. No flags, no `--` claude-arg passthrough — bare interactive shim. Workdir + auth are inherited from the original PID-1 claude; the attached claude's TUI label gets a `#<4hex>` suffix to disambiguate. Lifecycle: exiting the attached claude does **not** stop the container (only the PID-1 exit does), so handoff fires only when the original session ends. Resume is not supported on attach — use `ccairgap -r <id-or-name>` to start a new session that resumes a transcript instead. |
| `doctor` | Preflight checks: Docker running, credentials present, image present/stale, state dir writable, `git` + `rsync` + `cp` on PATH. Hash-compares any sidecar `Dockerfile` / `entrypoint.sh` against the bundled copies and warns on drift — useful after a CLI upgrade. |
| `init` | Scaffold `.ccairgap/{Dockerfile, entrypoint.sh, config.yaml}`. Fails if any file exists; `--force` overwrites. Add `--user` to scaffold the user-wide layer instead (see below). |
| `init --user` | Scaffold the user-wide config dir — `$XDG_CONFIG_HOME/ccairgap/` (default `~/.config/ccairgap/`) — creating `config.yaml` and an empty `integrations/` subdirectory. Fails if `config.yaml` already exists; `--force` overwrites it (the `integrations/` dir is always created if absent). Does not touch the project-layer Dockerfile or entrypoint. See [docs/config.md §"User-wide config"](config.md#user-wide-config) for all accepted keys and precedence. |
| `inspect` | Dump every hook, MCP server, env var, and marketplace mount the container would see at launch. JSON to stdout; `--pretty` for tables. Read-only. |
| `install-completion [<shell>]` | Install shell tab-completion (bash/zsh/fish). Writes one source line into your shell rc via `@pnpm/tabtab`. Completion covers subcommand names, launch flags, and dynamic candidates: session ids for `recover` / `discard`, custom titles for `-r` / `--resume`, shell names for `install-completion`. Omit `<shell>` to be prompted. |
| `uninstall-completion` | Remove ccairgap completion from every supported shell rc. Idempotent. |
