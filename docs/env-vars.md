# Host environment variables

Host-side env vars that ccairgap reads. Not to be confused with env vars forwarded into the container (use `docker-run-arg: ["-e NAME"]` — see [docker-run-args.md](docker-run-args.md)).

| Env var | Effect |
|---------|--------|
| `CCAIRGAP_HOME` | Override state dir. Default: `$XDG_STATE_HOME/ccairgap/`. |
| `CCAIRGAP_CC_VERSION` | Short-form for `--docker-build-arg CLAUDE_CODE_VERSION=<value>`. |
| `CLAUDE_CONFIG_DIR` | If set on the host, ccairgap resolves the host Claude config home and `.claude.json` inside that directory instead of `~/.claude` / `~/.claude.json`. Matches Claude Code's own convention. **Not** forwarded into the container — inside the sandbox the config home is always `~/.claude`. |
| `NODE_EXTRA_CA_CERTS` | If set on the host, the file is RO-bind-mounted at `/host-ca-certs/<basename>` inside the container and the env var is forwarded via `-e NODE_EXTRA_CA_CERTS=/host-ca-certs/<basename>`. Required for corporate TLS proxies. Missing file → stderr warning + skip. Mounted at a neutral container path so it doesn't overmount the base image's CA trust store. |
