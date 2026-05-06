# Auth refresh

Containers never hold a refresh token. The CLI strips `claudeAiOauth.refreshToken` from every session creds file before bind-mount, so the container's Claude Code only ever has an access token to spend — it can't race host or peer containers for Anthropic's once-per-refresh-token rotation window. This removes the "multiple concurrent containers → 401" failure mode that drove this feature.

To keep the access token fresh, ccairgap runs a short pre-launch refresh on the host:

1. Read the host token and check remaining ttl.
2. If ttl < `--refresh-below-ttl` minutes (default 120), acquire a `proper-lockfile` on host `~/.claude/` (same library and path Claude Code uses), invoke `claude auth login` with Claude Code's supported `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` + `CLAUDE_CODE_OAUTH_SCOPES` fast path, and re-read the authoritative post-refresh token.
3. Strip the refresh token and materialize `$SESSION/creds/.credentials.json` (mode 0600) for bind-mount at `/host-claude-creds-dir`.

The lockfile prevents two ccairgap launches from racing each other or racing a host-native `claude` that is mid-refresh.

## When refresh fails

- **Soft failure** (token still has ≥ 5 min of life): launch proceeds with a stderr banner telling you to `/login` in the Claude TUI if the token expires mid-session. The paste-code OAuth flow works inside the container without a browser.
- **Hard failure** (final ttl < 5 min — cold-start-dead): the CLI refuses to launch, prints the reason, and asks you to run `claude` on the host to re-login. This prevents handing you a container that would 401 on its first API call.

`--refresh-below-ttl 0` disables the refresh; the cold-start-dead refusal still fires. Pass a large value (e.g. `--refresh-below-ttl 9999`) if you want every launch to refresh.

`ccairgap doctor` shows the current host token ttl and OAuth scopes so you can see what containers will inherit.

See [SPEC.md](SPEC.md) §"Authentication flow" for the full mechanism, failure classification, and in-container behavior.

## Runtime refresh

While the container runs, the CLI polls every minute on the host. Each tick reads host creds (keychain on macOS, file on Linux); when the access token has under 30 minutes of life remaining it acquires the same `proper-lockfile` on host `~/.claude/` and calls `claude auth login` with the refresh-token env-var fast-path. The session creds file `$SESSION/creds/.credentials.json` is atomically rewritten (tmp + `fsync` + `rename(2)`) only when the stripped host content differs from the last write — no fsync churn on the steady-state path. The container's Claude Code picks up changed content through its mtime-cache invalidation — no restart, no in-container coordination.

Sleep / suspend on macOS: every tick reads host creds via `Date.now()` rather than relying on `setTimeout`'s monotonic countdown surviving a sleep cycle. After a multi-hour sleep the first post-resume tick refreshes if needed.

Host-driven account swap: if you run `/login` on the host and switch account mid-session, the next tick (≤60 s) reads the new account's creds, sees the content changed, and writes them to the session file. The container then talks to the new account on its next API request. The swap is silent — no banner — because you explicitly chose it on the host.

In-container `/login`: typing `/login` in Claude inside the container writes a fresh refresh-token-bearing JSON to the same file. The runtime watcher detects the mtime change, peeks `claudeAiOauth.refreshToken` in the new content, and ceases polling for the rest of the session — the container-scoped account takeover takes precedence. After preserve (dirty repo, scan failure, orphan branch), the resulting refresh token sits under `$XDG_STATE_HOME/ccairgap/<id>/creds/` — `ccairgap discard <id>` removes it.

Host-side external write (manual `cp` recovery, third-party tool): if you copy fresh creds into `$SESSION/creds/.credentials.json` to unstick a stale session, the watcher detects the mtime change, sees no `refreshToken` in the file (host-driven writes always strip), adopts the new content as its baseline, and keeps mirroring host on subsequent ticks. Future host refreshes still propagate; mirroring is never permanently severed.

Failure surfacing inside the TUI: 3 consecutive failures, or any failure under 15 minutes of remaining ttl, writes a banner to `$SESSION/auth-warnings/current.txt` which the entrypoint's UserPromptSubmit hook surfaces inside the session.

`ccairgap doctor` prints one row per live session with the most recent refresh result and the current ttl.
