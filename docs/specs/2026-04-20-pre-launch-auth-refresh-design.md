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

Three changes to the existing credentials flow (`src/credentials.ts`,
`docker/entrypoint.sh`, `docs/SPEC.md §Authentication flow`):

1. **Pre-launch refresh (best-effort, lock-coordinated).** Before
   materializing the session creds file, if the host token's remaining
   lifetime is below a configurable threshold, ccairgap acquires a
   `proper-lockfile` on host `~/.claude/` (same lib/path Claude Code
   uses at `src/utils/auth.ts:1491`) and invokes `claude auth login`
   with `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` and `CLAUDE_CODE_OAUTH_SCOPES`
   env vars. Claude Code's own fast-path (`cli/handlers/auth.ts:140-186`
   upstream) exchanges the refresh token for a fresh pair and writes
   back via `saveOAuthTokensIfNeeded`. Any running host `claude`
   processes pick up the new tokens via `invalidateOAuthCacheIfDiskChanged`.
   The lockfile wraps the read-ttl → refresh → re-read cycle so
   concurrent ccairgap launches serialize, and a host `claude` mid-refresh
   will wait for our lock (and vice versa).

2. **Strip `refreshToken` in the session creds file.** The session
   creds file written to `$SESSION/creds/.credentials.json` has the
   `claudeAiOauth.refreshToken` field omitted. All other fields
   (`accessToken`, `expiresAt`, `scopes`, `subscriptionType`,
   `rateLimitTier`) are preserved. The container's Claude Code sees a
   valid access token and no refresh token; its refresh path
   short-circuits on the `!tokens?.refreshToken` guard and never hits
   Anthropic.

3. **Hard-failure refuse on cold-start-dead.** If refresh fails AND the
   final TTL is below the `coldStartFloorMs` threshold (5 min),
   `resolveCredentials` throws `CredentialsDeadError` before any
   session-state mutation. The CLI exits 1 with a message pointing the
   user at `claude` on host. This prevents handing the user a container
   that will 10×401 on its first API call.

UX branches: cold-start-dead → exit 1 with refusal banner; soft failure
(refresh failed but token still has time) → launch with warning banner
describing TTL + `/login` recovery; success → silent (no banner).

## In-container behavior (verified against Claude Code source)

### Cold-start-dead is caught pre-launch

When refresh fails AND final TTL < 5 min, `resolveCredentials` throws
`CredentialsDeadError` before any container starts. The container never
sees an expired-on-arrival token, so the Claude Code cold-start guard
(`initReplBridge.ts:219-239` upstream, which may or may not apply to
the main TUI path — reviewer noted it's REPL-bridge-only) is not
relied upon. The user sees ccairgap's refusal banner, not a broken TUI.

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

The container's new refresh token is assumed to be a separate OAuth
grant from the host's, so host-native `claude` continues to work. This
assumption is unverified and accepted as a known risk — see Risks §2
for the reversion path if it proves false.

## Pre-launch refresh flow

`resolveCredentials` runs in `launch.ts` **before** `copyResumeTranscript`
and before any `mkdirSync($SESSION)` that would persist session state.
Errors thrown from it propagate and the CLI exits 1 with no side-effect
mutations — matching today's behavior when host creds are missing.

```
ccairgap launch
  │
  ├─ resolveCredentials(sessionDir, opts):
  │     ├─ read host creds (macOS keychain / Linux file) → string JSON
  │     ├─ parse → { expiresAt, scopes, refreshToken, accessToken, … }
  │     ├─ ttl = expiresAt − now
  │     │
  │     ├─ if ttl < refreshBelowMs (default 7_200_000 = 2h):
  │     │     acquire proper-lockfile on host `~/.claude/`
  │     │       (stale: 10s, retries: 5×backoff — same semantics Claude Code uses)
  │     │     │
  │     │     ├─ re-read host creds inside lock (another writer may have refreshed)
  │     │     ├─ if re-read ttl still < refreshBelowMs:
  │     │     │     refreshResult = tryRefresh({ refreshToken, scopes })
  │     │     │       └─ spawn `claude auth login`
  │     │     │            with CLAUDE_CODE_OAUTH_REFRESH_TOKEN, CLAUDE_CODE_OAUTH_SCOPES,
  │     │     │            stdin closed, stdout+stderr captured, timeout 120_000ms
  │     │     │       classify outcome (see Failure mode taxonomy)
  │     │     │     on ok: re-read host creds; ttl ≈ 8h
  │     │     ├─ else: refreshResult = { ok: true, action: "already-fresh" }
  │     │     │       (benign race-loss: another writer refreshed while we waited)
  │     │     └─ release lock (in `finally`)
  │     │
  │     ├─ else: refreshResult = { ok: true, action: "fresh" }
  │     │
  │     ├─ final re-read of host creds → authoritative ttl for banner
  │     │
  │     ├─ if refresh failed AND final ttl < coldStartFloorMs (5 min):
  │     │     throw `CredentialsDeadError(reason, ttlMs)`
  │     │     # resolves to CLI exit 1 with banner:
  │     │     #   ✗ Host auth is dead (<reason>; <Xm> left).
  │     │     #     Run `claude` on host to re-login, then retry.
  │     │
  │     ├─ strip `claudeAiOauth.refreshToken` from parsed object
  │     ├─ write $SESSION/creds/.credentials.json (0600) from stripped JSON
  │     └─ return { hostPath: sessionCredsPath, origin, refreshResult, finalTtlMs }
  │
  ├─ if refreshResult.ok === false  (soft failure: token still has >5min left):
  │     stderr:
  │       ⚠ Auth refresh failed: <reason>. Token expires HH:MM (Xm).
  │         When it hits: Claude will error. Run /login in Claude to recover.
  │
  ├─ [--resume only:] copyResumeTranscript(sessionDir, uuid)
  │     # reached only if creds are good; dead-auth exits before any session state is copied
  │
  └─ continue launch as today (mounts, docker run, …)
```

### Lockfile rationale

Claude Code's own refresh flow acquires `proper-lockfile` on `~/.claude/`
(`src/utils/auth.ts:1491` upstream). Its `claude auth login` env-var fast
path (`src/cli/handlers/auth.ts:140-186`) does **not** — it goes straight
into `refreshOAuthToken` + `installOAuthTokens` + `performLogout` +
`secureStorage.update()` without coordination. Two concurrent
`ccairgap launch` invocations would therefore race each other, and a
ccairgap launch would race a host `claude` process mid-refresh, with
`installOAuthTokens` tearing down the creds file during
`performLogout → secureStorage.delete()`.

Wrapping ccairgap's read-ttl → refresh → re-read cycle with
`proper-lockfile` on host `~/.claude/` uses the same library Claude Code
uses — Claude Code's own flow will wait for our lock to release, and
vice versa. This is the minimum coordination that makes the spec's
"no more 401 races" claim truthful.

### Resume interaction

`--resume <id-or-name>` validation (`resolveResumeArg` → `resolveResumeSource`)
and the session-state copy (`copyResumeTranscript`) must both run AFTER
`resolveCredentials` returns successfully. If host auth is dead,
`resolveCredentials` throws before any transcript is copied and before
any session-scoped state is written, so the user's resumable source
session on disk is never disturbed by a failed resume launch.

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
| `--refresh-below-ttl <mins>` | `refresh-below-ttl` / `refreshBelowTtl` | `120` | If host token has less than this many minutes of life remaining at launch, attempt `claude auth login` refresh. `0` disables pre-launch refresh entirely (cold-start-dead still refuses). No "always refresh" sentinel — pass a large value (e.g. `9999`) if you want every launch to refresh. |

No flag to disable the refresh-token strip or the cold-start-dead refuse
check: both are invariants — strip prevents the cross-container race,
refuse prevents handing the user a session guaranteed to 10×401 on first
prompt. Neither is user-configurable.

## Failure mode taxonomy

Two UX branches depending on post-refresh TTL:

- **Soft failure** (refresh failed, final ttl ≥ 5 min): launch proceeds,
  warning banner on stderr:

  ```
  ⚠ Auth refresh failed: <reason>. Token expires HH:MM (Xm).
    When it hits: Claude will error. Run /login in Claude to recover.
  ```

- **Hard failure** (refresh failed, final ttl < 5 min — the
  `coldStartFloorMs` threshold): refuse to launch, exit 1, message on
  stderr:

  ```
  ✗ Host auth is dead (<reason>; <Xm> left).
    Run `claude` on host to re-login, then retry ccairgap.
  ```

  Rationale: below the 5-min floor the container's Claude Code would hit
  401 on its first API call (10× retry then generic error), which is
  worse UX than a clean launch-time refusal. The floor matches Claude
  Code's own `isOAuthTokenExpired` buffer (`auth.ts:344-353`).

`<reason>` classification:

| Classification | Trigger | Reason text |
|---|---|---|
| `revoked` | stderr matches `/invalid_grant/` | `refresh token revoked` |
| `network` | stderr matches `/ENOTFOUND\|ETIMEDOUT\|ECONNREFUSED\|getaddrinfo\|network/i` | `network error contacting Anthropic` |
| `binary-missing` | spawn errors with `ENOENT` | `claude not on PATH` |
| `timeout` | `execa` timeout fires | `claude auth login timed out after 120s` |
| `unknown` | any other non-zero exit | first line of stderr (truncated to 120 chars) |

## Coupling surface

This design is coupled to Claude Code in five places. Each is a stable
public interface or a documented data shape:

1. **Creds file field names** — `claudeAiOauth.{accessToken,expiresAt,
   refreshToken,scopes}`. Field rename would break read+write.
2. **`claude auth login` CLI subcommand** — public CLI, exit-code
   contract, stdout "Login successful." string.
3. **Env vars `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`, `CLAUDE_CODE_OAUTH_SCOPES`**
   — public fast-path (upstream `cli/handlers/auth.ts:140-186`).
4. **Behavior when `refreshToken` is absent** — early return at
   `auth.ts:1459`, no-op at `auth.ts:1380` in 401 handler, bounded
   10×401 retry in `withRetry.ts:232-253,773-775` then `CannotRetryError`.
   Verified against current source.
5. **`proper-lockfile` on host `~/.claude/`** — same library Claude
   Code uses (`src/utils/auth.ts:1491`). ccairgap adds `proper-lockfile`
   as a new runtime dep to acquire the same lock around its refresh
   cycle; Claude Code's own refresh waits for ours and vice versa.

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
- **CLAUDE.md / SPEC.md §"Host writable paths"** — ccairgap does not
  directly write to host `~/.claude/.credentials.json` or the macOS
  keychain. It invokes the supported public `claude auth login`
  subcommand, which writes to its own state via its own storage paths.
  The invariant is clarified: "Host writable paths are closed set"
  refers to paths ccairgap itself writes, not incidental writes made by
  host-side CLI tools ccairgap invokes in a supported way. The SPEC
  update adds one sentence of carve-out to the relevant section.
- `docs/SPEC.md §Authentication flow` (lines 543-559) rewritten — see
  Implementation plan below.
- `docs/SPEC.md §Container mount manifest` — the row describing
  `/host-claude-creds` is updated: source is always a session-local
  materialized file on both platforms.

## Risks

1. **Anthropic access-token lifetime shrinks.** Currently ~8 hours
   (measured: 479 min immediately post-refresh). If Anthropic cuts this
   to e.g. 1 hour, mid-session expiry becomes common. Mitigation: lower
   `refresh-below-ttl` default, expose to config; user can also just
   `/login` more often. Not a breaking change, only a UX regression.
2. **Anthropic revokes concurrent OAuth grants on in-container `/login`.**
   If `/login` inside one container invalidates the host's refresh
   token chain (rather than issuing an independent grant), recovering a
   container would also break the host. No evidence this happens today
   — standard OAuth2 authorization-code flow issues an independent
   grant per `/login`, and Anthropic's token endpoint is documented as
   using refresh-token rotation (per-grant), not grant revocation on
   new login. **This design accepts the risk without empirical
   verification**: if the assumption proves wrong, every in-container
   `/login` forces a host re-login and the recovery story collapses.
   Mitigation: document the symptom prominently in README; if user
   reports trigger it, revert to "refuse to launch when token low + no
   `/login` recovery" posture by setting `refresh-below-ttl` high and
   removing the `/login` hint from the soft-failure banner. No code
   change needed for the revert.
3. **Claude Code stops tolerating a missing `refreshToken`.** If upstream
   adds a hard requirement that `refreshToken` be present (e.g. crashes
   on `undefined`, loops on refresh-failure), containers break.
   Mitigation: the Dockerfile pins `CLAUDE_CODE_VERSION`; user opts into
   upgrades. Fallback would be to re-introduce refresh coordination
   (broker daemon), which is out of scope here.
4. **`claude auth login` fast-path env vars rename or removed.** Refresh
   silently becomes no-op (env vars unread → interactive browser flow →
   blocks on stdin). Mitigation: `execa` `stdin: "ignore"` so stdin read
   returns EOF immediately instead of blocking; `timeout: 120_000ms`
   backstop. On timeout, classify as `timeout` and treat as soft/hard
   failure per final-ttl branching.
5. **`installOAuthTokens` partial-completion under timeout.** The
   upstream sequence is `performLogout()` → `secureStorage.delete()` →
   (fetch profile/roles) → `secureStorage.update()` → write config.
   A 120s outer timeout firing in the middle of this sequence could
   leave the keychain/file emptied (post-delete, pre-update). Mitigation:
   120s is well above the internal `refreshOAuthToken` timeout
   (axios 15s) + profile fetch + save — in practice the outer timeout
   should only fire on host hangs, not mid-write. Documented as a
   known-low-probability hazard; no atomic-rollback harness is added.
6. **`proper-lockfile` stale-lock on crashed writer.** If a ccairgap
   process is SIGKILL'd mid-refresh, the lockfile is left on disk.
   Mitigation: `proper-lockfile`'s `stale: 10000ms` + mtime refresh on
   the lock holder lets subsequent callers reclaim. Same configuration
   Claude Code uses.
7. **Concurrent-burst launches.** Ten `ccairgap launch` in parallel
   with a near-expired token all enter the lock serially. First one
   refreshes; subsequent ones re-read in-lock, see a fresh token,
   skip refresh (`action: "already-fresh"`). Latency cost is the time
   for one refresh round-trip (~1–2s) times 10 launches worst-case.
   Acceptable; documented. No jitter added.

## Open questions

None remaining. The "/login invalidates host grant" question is
accepted as an unverified risk (see Risks §2) rather than blocking.
`doctor` stays read-only — no dry-run refresh probe — with a failing
refresh at launch surfaced via the banner instead.

## Implementation plan (summary — detailed plan lives in `writing-plans`)

New runtime dep: `proper-lockfile` (and its types `@types/proper-lockfile`
for dev). Already a transitive dep of Claude Code, mature, no native
build.

Files:

- **New:** `src/authRefresh.ts`
  - `refreshIfLowTtl(hostCredsPath, refreshBelowMs, coldStartFloorMs): Promise<RefreshResult>`.
  - Owns: `proper-lockfile` acquire/release on `dirname(hostCredsPath)`,
    in-lock re-read, `execa` spawn of `claude auth login` (stdin ignored,
    120s timeout), outcome classification, final re-read.
  - Returns `{ ok: true, action, finalTtlMs }` on success (soft or fresh)
    or `{ ok: false, reason, classification, finalTtlMs }` on failure.
- **New:** `src/authRefresh.test.ts`
  - Mocks `execa` + `proper-lockfile` + fs read/write.
  - Cases: ttl above threshold (no exec), ttl below → refresh ok,
    ttl below → another writer refreshed while we waited (benign
    race-loss), each failure classification, hard-failure TTL-below-floor.
- **Modify:** `src/credentials.ts`
  - `resolveCredentials` always materializes to session file (drop Linux
    direct-mount path).
  - Call `refreshIfLowTtl` on the host creds path.
  - If `refreshResult.ok === false` AND `finalTtlMs < 5 * 60_000`: throw
    `CredentialsDeadError(reason, finalTtlMs)` — caller exits 1 with
    hard-failure banner; no session dir mutation.
  - Otherwise, parse re-read host JSON, `delete parsed.claudeAiOauth.refreshToken`,
    `JSON.stringify` + write to `$SESSION/creds/.credentials.json` (0600).
  - Return `{ hostPath, origin, refreshResult, finalTtlMs }`.
  - Unit tests: stripped field absent; other fields preserved byte-identical;
    hard-failure error surfaced with readable message.
- **Modify:** `src/launch.ts`
  - Call `resolveCredentials` BEFORE `copyResumeTranscript` and before
    any session-state mutation beyond the `sessionDir` directory itself.
  - Thread `refreshBelowMs` from merged config.
  - Catch `CredentialsDeadError` at top level → emit hard-failure banner,
    exit 1.
  - On soft `refreshResult.ok === false`, emit soft-failure banner to stderr.
- **Modify:** `src/cli.ts` — register `--refresh-below-ttl` (number, minutes, default 120).
- **Modify:** `src/config.ts` — register `refresh-below-ttl` / `refreshBelowTtl` scalar; CLI > config > default 120.
- **Modify:** `src/subcommands.ts` — `doctor` prints host TTL in minutes + space-separated scopes list. No UUIDs, no timestamps, no token material.
- **Modify:** `docs/SPEC.md` — rewrite `§Authentication flow` (lines 543-559), update `§Container mount manifest` row for `/host-claude-creds`, add one-sentence carve-out to `§Host writable paths` clarifying that invoking `claude auth login` on host is not a direct ccairgap write.
- **Modify:** `README.md` — new "Auth refresh" section under the relevant header.
- **Modify:** `CLAUDE.md` — update the "Creds path differs by OS" and "container's copy is writable" invariants.
- **New:** `e2e/tests/auth-strip.e2e.ts` — Tier-2 e2e using `CCAIRGAP_TEST_CMD` that asserts `~/.claude/.credentials.json` inside container has `.claudeAiOauth.refreshToken` absent (`jq` check via `CCAIRGAP_TEST_CMD`). Enforces the strip invariant at the integration layer.
- **Modify:** `package.json` — add `proper-lockfile` + `@types/proper-lockfile`.

Size estimate: ~150 LOC source (up from 100 due to lockfile + hard-failure
path), ~80 LOC tests, ~50 lines docs. One new runtime dep
(`proper-lockfile`, same lib Claude Code uses).
