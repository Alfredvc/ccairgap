# Auth refresh

Containers never hold a refresh token. The CLI strips `claudeAiOauth.refreshToken` from every session creds file before bind-mount, so the container's Claude Code only ever has an access token to spend — it can't race host or peer containers for Anthropic's once-per-refresh-token rotation window. This removes the "multiple concurrent containers → 401" failure mode that drove this feature.

To keep the access token fresh, ccairgap runs a short pre-launch refresh on the host:

1. Read the host token and check remaining ttl.
2. If ttl < `--refresh-below-ttl` minutes (default 120), acquire a `proper-lockfile` on host `~/.claude/` (same library and path Claude Code uses), invoke `claude auth login` with Claude Code's supported `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` fast path, and re-read the authoritative post-refresh token.
3. Strip the refresh token and materialize `$SESSION/creds/.credentials.json` (mode 0600) for bind-mount at `/host-claude-creds`.

The lockfile prevents two ccairgap launches from racing each other or racing a host-native `claude` that is mid-refresh.

## When refresh fails

- **Soft failure** (token still has ≥ 5 min of life): launch proceeds with a stderr banner telling you to `/login` in the Claude TUI if the token expires mid-session. The paste-code OAuth flow works inside the container without a browser.
- **Hard failure** (final ttl < 5 min — cold-start-dead): the CLI refuses to launch, prints the reason, and asks you to run `claude` on the host to re-login. This prevents handing you a container that would 401 on its first API call.

`--refresh-below-ttl 0` disables the refresh; the cold-start-dead refusal still fires. Pass a large value (e.g. `--refresh-below-ttl 9999`) if you want every launch to refresh.

`ccairgap doctor` shows the current host token ttl and OAuth scopes so you can see what containers will inherit.

See [SPEC.md](SPEC.md) §"Authentication flow" for the full mechanism, failure classification, and in-container behavior.
