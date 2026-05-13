# Host environment variables

Host-side env vars that ccairgap reads. Not to be confused with env vars forwarded into the container (use `docker-run-arg: ["-e NAME"]` — see [docker-run-args.md](docker-run-args.md)).

| Env var | Effect |
|---------|--------|
| `CCAIRGAP_HOME` | Override state dir. Default: `$XDG_STATE_HOME/ccairgap/`. |
| `CCAIRGAP_CC_VERSION` | Short-form for `--docker-build-arg CLAUDE_CODE_VERSION=<value>`. |
| `CCAIRGAP_REGISTRY` | Override the container-image registry repo used for the pull-then-build fallback. Default: `ghcr.io/alfredvc/ccairgap`. Format: `<host>/<owner>/<repo>` (no tag — the CLI appends `:<version>-<hash8>`). Use for forks or private mirrors. |
| `CODEX_HOME` | Host-side Codex home used for staged Codex state preparation. Defaults to `~/.codex`. The resolved absolute host path is used for sanitized session-local config/auth and later manifest authority. |
| `CLAUDE_CONFIG_DIR` | If set on the host, ccairgap resolves the host Claude config home and `.claude.json` inside that directory instead of `~/.claude` / `~/.claude.json`. Matches Claude Code's own convention. **Not** forwarded into the container — inside the sandbox the config home is always `~/.claude`. |
| `NODE_EXTRA_CA_CERTS` | If set on the host, the file is RO-bind-mounted at `/host-ca-certs/<basename>` inside the container and the env var is forwarded via `-e NODE_EXTRA_CA_CERTS=/host-ca-certs/<basename>`. Required for corporate TLS proxies. Missing file → stderr warning + skip. Mounted at a neutral container path so it doesn't overmount the base image's CA trust store. |

## Container runtime variables

These are set inside Docker by ccairgap or by the entrypoint contract:

| Env var | Effect |
|---------|--------|
| `CCAIRGAP_AGENT` | Selects the entrypoint branch. Defaults to `claude`; `codex` launches the Codex branch in interactive mode or `codex exec` in print mode. |
| `CCAIRGAP_PRINT` | Prompt for non-interactive print mode. Claude receives it as the final `-p` prompt; Codex receives it as the final `codex exec` prompt. |
| `CODEX_HOME` | Codex config/session home inside the container. Defaults to `/home/claude/.codex`; the image pre-creates this directory and `sessions/`. |
| `CCAIRGAP_ENTRYPOINT_DRY_RUN` | Test-only entrypoint mode. When set to `1`, setup runs, the selected command is printed, and the entrypoint exits before `exec`. |
