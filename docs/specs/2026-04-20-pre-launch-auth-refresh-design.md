# Pre-Launch Auth Refresh + Stripped Refresh Token — Design Spec

**Status:** Draft — awaiting user approval
**Date:** 2026-04-20
**Author:** ccairgap maintainers

## Problem

Running multiple ccairgap sessions concurrently (and running ccairgap alongside
a host-native `claude` session) frequently produces 401 errors from Anthropic
that force a full re-login. The root cause is the OAuth refresh-token race:

1. Each container receives a copy of the host's `~/.claude/.credentials.json`
   — on macOS via `$SESSION/creds/.credentials.json` materialized from the
   keychain, on Linux via a direct bind-mount of the host file. Either way,
   the entrypoint's `cp -L /host-claude-creds → ~/.claude/.credentials.json`
   produces an in-container copy that Claude Code can refresh in place.
2. When the access token expires, each container independently enters
   Claude Code's refresh flow (`src/utils/auth.ts:1427-1562` upstream),
   acquires a `proper-lockfile` lock on its **own private** `~/.claude/`
   directory, and `POST`s `platform.claude.com/v1/oauth/token` with
   `grant_type=refresh_token`.
3. Anthropic's token endpoint rotates the refresh token on use (standard
   OAuth2 security behavior — RFC 9700 §4.13). The first caller gets a new
   pair; subsequent callers send a now-invalidated refresh token and receive
   `invalid_grant` → 401.
4. The container whose refresh lost the race cannot recover (its local
   creds file still holds the invalidated refresh token) and will continue
   hitting 401 until the user re-logs in.

Claude Code upstream has a cross-process coordinator (`proper-lockfile` on
`~/.claude/`, plus a `pendingRefreshCheck` in-process promise mutex and pre/post-lock
re-reads) that handles this correctly when all processes share the same
`~/.claude/` directory on the same filesystem. ccairgap defeats the coordinator
by giving each container its own private copy.

Upstream issues confirm the problem is real and unresolved:
[anthropics/claude-code#24317](https://github.com/anthropics/claude-code/issues/24317),
[#27933](https://github.com/anthropics/claude-code/issues/27933),
[#12447](https://github.com/anthropics/claude-code/issues/12447).

## Goal

Eliminate the cross-container refresh race without breaking the ccairgap
airgap invariants:

- Host-native `claude` continues to work unchanged.
- Container never holds a valid refresh token, so no container can race.
- Refresh happens once, on host, inside ccairgap's own launch path — via
  Claude Code's supported `claude auth login` env-var fast-path — so we do
  not reimplement OAuth.
- Container sessions remain recoverable from mid-session token expiry
  without restarting the container: user types `/login` in the TUI,
  completes the paste-code flow, continues working.

## Non-goals

- Sharing a single refresh-token chain across N containers (would require a
  daemon/broker; user explicitly rejected that scope).
- Proactive mid-session token refresh from host into running containers
  (same reason).
- Write-back of container-refreshed tokens to the host keychain. Containers
  will not refresh at all under this design.
- Preventing the bounded 10 × 401 retry loop that Claude Code's `withRetry`
  performs on mid-session expiry. That behavior is upstream; we cannot fix
  it from ccairgap. We mitigate it by starting sessions with a token as
  fresh as possible.
- Supporting `ANTHROPIC_API_KEY` as an alternative auth mode. Already
  inherited transparently via the `~/.claude/` flow; this design does not
  change that path.
- Coordinating with other third-party tools that read the host credentials
  file.

## Design summary

Two changes to the existing credentials flow (`src/credentials.ts`,
`docker/entrypoint.sh`, `docs/SPEC.md §Authentication flow`):

1. **Pre-launch refresh (best-effort).** Before materializing the session
   creds file, if the host token's remaining lifetime is below a
   configurable threshold, ccairgap invokes `claude auth login` on the host
   with `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and `CLAUDE_CODE_OAUTH_SCOPES`
   env vars set from the current creds. Claude Code's own fast-path
   (`cli/handlers/auth.ts:140-186` upstream) exchanges the refresh token
   for a fresh pair and writes back via `saveOAuthTokensIfNeeded` under
   its native `proper-lockfile` coordination. Any running host `claude`
   processes pick up the new tokens via their existing
   `invalidateOAuthCacheIfDiskChanged` disk-change detection.

2. **Strip `refreshToken` in the session creds file.** The session creds
   file written to `$SESSION/creds/.credentials.json` has the
   `claudeAiOauth.refreshToken` field omitted. All other fields
   (`accessToken`, `expiresAt`, `scopes`, `subscriptionType`,
   `rateLimitTier`) are preserved. The container's Claude Code sees a
   valid access token and no refresh token; its refresh path
   short-circuits on the `!tokens?.refreshToken` guard and never hits
   Anthropic.

Success cases are silent (normal launch). The single failure case
(refresh attempt failed) emits one banner line on stderr describing
the remaining TTL and pointing the user at the in-TUI `/login`
recovery path.

## In-container behavior (verified against Claude Code source)

### Cold start with near-expired or expired access token

`initReplBridge.ts:219-239` (upstream) detects expired-and-unrefreshable
state and signals `onStateChange('failed', '/login')` without making any
API call. User sees the standard `/login` prompt inside the TUI.

### Healthy session with fresh token

No refresh attempt is made while `isOAuthTokenExpired(expiresAt)` returns
false (check includes a 5-minute buffer). Container uses the access
token normally.

### Mid-session expiry

Claude Code calls `checkAndRefreshOAuthTokenIfNeededImpl`; the guard at
`auth.ts:1459` returns early because `!tokens?.refreshToken` is true.
The next API request therefore proceeds with the now-expired access
token and receives 401. `handleOAuth401Error` (`auth.ts:1380-1382`) sees
no refresh token and returns `false`. `withRetry`
(`withRetry.ts:232-253`, `773-775`) unconditionally retries 401s and
cycles up to `maxRetries = 10` before throwing `CannotRetryError`.

The user-visible effect is ~10 × 401 round-trips to Anthropic (few
seconds) followed by a generic error. The session remains alive; the
user types `/login` in the TUI to recover.

### Recovery via `/login` in TUI

`src/commands/login/login.tsx` + `src/components/ConsoleOAuthFlow.tsx`
(upstream) support a paste-code OAuth flow
(`PASTE_HERE_MSG = 'Paste code here if prompted > '`) that works
without a container-side browser:

1. User types `/login` in the TUI.
2. TUI prints the auth URL.
3. User opens the URL on the host browser, completes login, copies the
   auth code.
4. User pastes the code back in the TUI.
5. `installOAuthTokens` writes a fresh token pair (including a new
   refresh token) into the container's `~/.claude/.credentials.json`.
6. Session continues with the container-scoped token chain.

The container's new refresh token is a separate OAuth grant from the
host's; it does not invalidate the host token chain. Host-native
`claude` continues to work.

## Pre-launch refresh flow

```
ccairgap launch
  │
  ├─ resolveCredentials(sessionDir):
  │     ├─ read host creds (macOS keychain / Linux file) → string JSON
  │     ├─ parse → { expiresAt, scopes, refreshToken, accessToken, … }
  │     ├─ ttl = expiresAt − now
  │     ├─ if ttl < refreshBelowMs (default 7_200_000 = 2h):
  │     │     refreshResult = tryRefresh({ refreshToken, scopes })
  │     │       └─ spawn `claude auth login`
  │     │            with CLAUDE_CODE_OAUTH_REFRESH_TOKEN,
  │     │                 CLAUDE_CODE_OAUTH_SCOPES,
  │     │            capturing stdout+stderr, no stdin
  │     │       classify outcome:
  │     │         - exit 0 + "Login successful." → ok
  │     │         - exit 1 + stderr matches `invalid_grant` → revoked
  │     │         - exit 1 + network-related stderr → network
  │     │         - ENOENT / spawn EACCES → binary-missing
  │     │         - anything else → unknown (reason = full first stderr line)
  │     │     on ok: re-read host creds; ttl ≈ 8h
  │     ├─ else: refreshResult = { ok: true, action: "fresh" }
  │     ├─ strip refreshToken from the parsed object
  │     ├─ write $SESSION/creds/.credentials.json (0600) from stripped JSON
  │     └─ return { hostPath: sessionCredsPath, origin, refreshResult }
  │
  ├─ if refreshResult is a failure:
  │     stderr:
  │       ⚠ Auth refresh failed: <reason>. Token expires HH:MM (Xm).
  │         When it hits: Claude will error. Run /login in Claude to recover.
  │
  └─ continue launch as today (mounts, docker run, …)
```

## Platform unification

Before this change:

- macOS: `resolveCredentials` materialized keychain → session file, bind-mounted session file.
- Linux: `resolveCredentials` returned `~/.claude/.credentials.json` directly for bind-mount.

After this change, **both platforms materialize to a session file** because
the session file is always a *modified* copy (refresh_token stripped). The
host-file direct-mount path is removed.

This supersedes the existing CLAUDE.md invariant
`"Creds path differs by OS … Linux: bind-mount ~/.claude/.credentials.json directly"`.
The new invariant: session file always materialized, always stripped.

## CLI surface

One new flag and one new config key:

| Flag | Config key | Default | Semantics |
|---|---|---|---|
| `--refresh-below-ttl <mins>` | `refresh-below-ttl` / `refreshBelowTtl` | `120` | If host token has less than this many minutes of life remaining at launch, attempt `claude auth login` refresh. Set to `0` to disable pre-launch refresh entirely. |

No flag to disable the refresh-token strip: the strip is the invariant
that prevents the race and is not user-configurable.

## Failure mode taxonomy

The banner's `<reason>` value is a short classified string:

| Classification | Trigger | Banner reason | Recovery hint |
|---|---|---|---|
| `revoked` | stderr matches `/invalid_grant/` | `refresh token revoked` | run `claude` on host to log in |
| `network` | stderr matches `/ENOTFOUND\|ETIMEDOUT\|ECONNREFUSED\|getaddrinfo\|network/i` | `network error contacting Anthropic` | check connectivity; retry |
| `binary-missing` | spawn errors with `ENOENT` | `claude not on PATH` | ensure `claude` is installed on host |
| `unknown` | any other non-zero exit | first line of stderr (truncated to 120 chars) | — |

Classification is advisory; the banner always prints the TTL and the
`/login in Claude` recovery hint regardless of cause.

## Coupling surface

This design is coupled to Claude Code in exactly four places. Each is a
stable public interface or a documented data shape:

1. **Creds file field names** — `claudeAiOauth.{accessToken,expiresAt,
   refreshToken,scopes}`. Field rename would break read+write.
2. **`claude auth login` CLI subcommand** — public CLI, exit-code
   contract, stdout "Login successful." string. Not part of this repo's
   tests.
3. **Env vars `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES`**
   — public fast-path (upstream `cli/handlers/auth.ts:140-186`).
4. **Behavior when `refreshToken` is absent** — cold-start clean fail at
   `initReplBridge.ts:219`, early return at `auth.ts:1459`, no-op at
   `auth.ts:1380` in 401 handler. Verified against current source.

Upstream changes that would break this design are listed in the
"Risks" section.

## Removed / updated invariants

- **CLAUDE.md "Creds path differs by OS"** is replaced by "Creds path is
  uniform: always `$SESSION/creds/.credentials.json`, always stripped of
  `refreshToken`."
- **CLAUDE.md "The container's copy is writable, so Claude Code can
  refresh the access token in-place during the session"** becomes
  "The container's copy is writable but contains no refresh token;
  Claude Code never refreshes in-container. Mid-session expiry is
  recovered via `/login` in the TUI."
- `docs/SPEC.md §Authentication flow` (lines 543-559) rewritten — see
  Implementation notes below.
- `docs/SPEC.md §Container mount manifest` — the row describing
  `/host-claude-creds` is updated: source is always a session-local
  materialized file on both platforms.

## Risks

1. **Anthropic access-token lifetime shrinks.** Currently ~8 hours
   (measured: 479 min immediately post-refresh). If Anthropic cuts this
   to e.g. 1 hour, mid-session expiry becomes common. Mitigation: lower
   `refresh-below-ttl` default, expose to config; user can also just
   `/login` more often. Not a breaking change, only a UX regression.
2. **Anthropic revokes concurrent OAuth grants on new `/login`.** If a
   `/login` inside one container invalidates the host's refresh token
   chain (rather than issuing an independent grant), recovering one
   container would break the host. No evidence this happens today, but
   needs to be verified empirically before this design is considered
   complete. See "Open questions".
3. **Claude Code stops tolerating a missing `refreshToken`.** If upstream
   adds a hard requirement that `refreshToken` be present (e.g. crashes
   on `undefined`, loops on refresh-failure), containers break. Mitigation:
   the Dockerfile pins `CLAUDE_CODE_VERSION`; user opts into upgrades.
   Fallback would be to re-introduce refresh coordination (broker daemon),
   which is out of scope here.
4. **`claude auth login` fast-path env vars rename or removed.** Refresh
   silently becomes no-op (env vars unread → interactive browser flow →
   blocks). Mitigation: `execa` timeout; on timeout treat as `network`
   classification and fall through. Add timeout constant (30s).
5. **`installOAuthTokens` side effects** — upstream calls `performLogout`
   before writing new tokens, which clears account-info cache. Verified
   that this does not disrupt running host `claude` TTY sessions (they
   hold tokens in memory; next refresh re-reads disk and picks up new
   tokens). Not a risk today but documented because it is surprising.

## Open questions

1. Does `/login` inside a container invalidate the host's OAuth grant
   chain? Resolution: run the empirical test before committing the
   strip. Steps: host `claude` logged in; launch ccairgap container;
   inside container `/login` and complete paste-code flow; on host run
   `claude` and attempt a trivial request; observe whether host
   succeeds or is forced to re-login.
2. Should `ccairgap doctor` attempt a dry-run refresh (pass the
   refresh-token through a `--dry-run`-style probe) to verify the
   env-var fast path still works? Current answer: no, `doctor` stays
   read-only; a failing refresh at launch is visible via the banner.

## Implementation plan (summary — detailed plan lives in `writing-plans`)

Files:

- **New:** `src/authRefresh.ts` — `refreshIfLowTtl(credsPath, refreshBelowMs): Promise<RefreshResult>`; owns the `execa` spawn, reason classification, timeout.
- **New:** `src/authRefresh.test.ts` — mocks `execa`: happy (refreshed), no-op (ttl ok), each failure classification.
- **Modify:** `src/credentials.ts`
  - `resolveCredentials` always materializes to session file (drop Linux direct-mount path).
  - After reading host creds, call `refreshIfLowTtl(hostCredsPath, opts.refreshBelowMs)`.
  - After refresh (success or failure), re-read host creds, strip
    `claudeAiOauth.refreshToken`, write stripped JSON to
    `$SESSION/creds/.credentials.json` (0600).
  - Return `{ hostPath, origin, refreshResult }` so `launch.ts` can emit the banner.
  - Add unit test coverage for: stripped field absent from output, other
    fields preserved byte-identical.
- **Modify:** `src/launch.ts`
  - Thread `refreshBelowMs` from merged config into `resolveCredentials`.
  - On `refreshResult.ok === false`, emit banner to stderr.
- **Modify:** `src/cli.ts` — register `--refresh-below-ttl` (number, minutes).
- **Modify:** `src/config.ts` — register `refresh-below-ttl` / `refreshBelowTtl` scalar; CLI > config > default.
- **Modify:** `src/subcommands.ts` — `doctor` prints host TTL + scopes.
- **Modify:** `docs/SPEC.md` — rewrite `§Authentication flow`, update `§Container mount manifest` row for `/host-claude-creds`.
- **Modify:** `README.md` — new "Auth refresh" section under the relevant header.
- **Modify:** `CLAUDE.md` — update the "Creds path differs by OS" and "container's copy is writable" invariants.

Size estimate: ~100 LOC source, ~60 LOC tests, ~50 lines of docs. No new runtime deps (`execa` already present).
