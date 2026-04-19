# `ccairgap --resume`: resume a host-started Claude session inside the sandbox

Status: draft
Date: 2026-04-19

## Problem

ccairgap today supports resuming **only in one direction**: a session started inside ccairgap can be resumed on the host (the exit trap copies `$SESSION/transcripts/<encoded-cwd>/` back into `~/.claude/projects/<encoded-cwd>/`). The reverse — starting in the container against a host-born or previously-ccairgap-born session — does not work. On launch the container's `~/.claude/projects/` is an empty per-session bind mount, so `claude -r <uuid>` finds no transcript.

## Goal

`ccairgap -r, --resume <session-id>` launches a sandbox session that continues `<session-id>` regardless of where it was originally started, with no separate UX for "host-born" vs "ccairgap-born" transcripts.

## Non-goals

- **No picker mode.** `claude -r` with no value opens an interactive picker; ccairgap does not support that for now. Picker would require copying in the full `<encoded-cwd>` tree per repo; defer until a concrete need.
- **Not piggybacking on `/resume` inside the container.** `/resume` inside the TUI also needs the full dir; out of scope here.
- **No resume of subagent-only sessions.** Sessions whose main `<uuid>.jsonl` is missing (only a `<uuid>/subagents/` dir exists) are not resumable — same behavior as host claude.
- **No transcript rewriting.** Container writes the resumed jsonl as-is; exit trap copies back with the usual UUID-based merge.

## User-visible surface

### Flag

| Flag | Value | Semantics |
|------|-------|-----------|
| `-r, --resume <session-id>` | UUID (required) | Resume the given session. Workspace repo (`--repo`) is the cwd lookup anchor. |

Config key: `resume: <uuid>` (scalar; CLI overrides config, same precedence as other scalars).

### Interaction with existing flags

- **`--name`**: orthogonal. If set, ccairgap renames the resumed session — claude's `-r <uuid> -n <name>` semantics (verified: emits a new `agent-name` entry on the same `sessionId`). The title hook stamps `[ccairgap] <name>`.
- **`--name` not set**: ccairgap preserves the original display name. The CLI extracts the latest `{"type":"agent-name","agentName":"…"}` entry from the source jsonl and forwards it to the entrypoint; the title hook emits `[ccairgap] <original>`. If no `agent-name` entry exists, the hook emits bare `[ccairgap]`.
- **`--print`**: compatible. `claude -p -r <uuid>` works.
- **`--base`**: still honored. The sandbox branch is independent of the transcript; `ccairgap/<ts>` (or `ccairgap/<--name>`) is still created from `--base`. Lets the user resume an old conversation against a fresh branch off of main.
- **`--bare` / no workspace repo**: error. Resume requires a cwd anchor to find the source jsonl. Error message: `--resume requires a workspace repo (--repo or cwd git repo); got --bare or ro-only`.

### Error surface

- Source file missing: `--resume <uuid>: transcript not found at ~/.claude/projects/<encoded>/<uuid>.jsonl`. Exit 1 before any session-dir side effects.
- UUID format: not validated locally. Pass through to claude — the not-found error above catches typos anyway, and locking the format risks drifting from whatever claude accepts.
- Multi-repo: only the workspace repo (`repoPlans[0].hostPath`) is used for encoding. `--extra-repo` doesn't influence resume; transcripts live per-cwd and the cwd is the workspace.

## Mechanism

### Pre-launch copy-in

In `src/launch.ts` side-effect phase, after `mkdirSync($SESSION/transcripts)` and before docker run:

1. Compute `encoded = encodeCwd(repoEntries[0].hostPath)`.
2. Source paths:
   - `src_jsonl = ~/.claude/projects/<encoded>/<uuid>.jsonl`
   - `src_subagents = ~/.claude/projects/<encoded>/<uuid>/` (optional, present only if the session spawned subagents)
3. Destination paths:
   - `dst_jsonl = $SESSION/transcripts/<encoded>/<uuid>.jsonl`
   - `dst_subagents = $SESSION/transcripts/<encoded>/<uuid>/`
4. `mkdirSync($SESSION/transcripts/<encoded>, { recursive: true })`, then `cp -a` the jsonl and (if exists) the subagents dir.
5. On `src_jsonl` missing → die with the error above. On `src_subagents` missing → silent (it's optional).

Copy strategy: plain `cp -a` (not hardlinks). The container appends to the jsonl on resume; hardlinks would corrupt the host transcript pre-exit. The exit trap's existing UUID-keyed merge handles copy-back.

### Name extraction

Helper in `src/resume.ts`: read the source jsonl as UTF-8 text, split on `\n`, iterate **in reverse**, `JSON.parse` each non-empty line inside a try/catch, return the first entry with `type === "agent-name"` — read `agentName`. Fail open: if parse throws or no match, return `undefined`.

Rationale for reverse: names can be changed mid-session via `/rename` or subsequent `-n`; the latest entry wins. Transcripts can reach tens of MB; reverse-scan is O(lines-until-last-rename) in the typical case but falls back to full scan if the session never renamed. Acceptable — this runs once per launch.

### Env vars into container

| Env var | When set | Consumer |
|---------|----------|----------|
| `CCAIRGAP_RESUME` | `--resume <uuid>` passed | entrypoint: append `-r "$CCAIRGAP_RESUME"` to claude exec |
| `CCAIRGAP_RESUME_ORIG_NAME` | `--resume` passed AND `--name` not passed AND extraction found a name | entrypoint: title hook emits `[ccairgap] $CCAIRGAP_RESUME_ORIG_NAME` |

### Entrypoint changes (`docker/entrypoint.sh`)

Two sites change. Both branch on `CCAIRGAP_RESUME`.

**Title hook (lines 92-98 today):**

```bash
TITLE_HOOK="/tmp/ccairgap-session-title.sh"
cat > "$TITLE_HOOK" << 'HOOK_EOF'
#!/bin/sh
if [ -n "${CCAIRGAP_NAME:-}" ]; then
    TITLE="[ccairgap] $CCAIRGAP_NAME"
elif [ -n "${CCAIRGAP_RESUME_ORIG_NAME:-}" ]; then
    TITLE="[ccairgap] $CCAIRGAP_RESUME_ORIG_NAME"
else
    TITLE="[ccairgap]"
fi
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"%s"}}\n' "$TITLE"
HOOK_EOF
```

**Exec block (lines 134-144 today):**

```bash
# Name: explicit --name wins. Otherwise, on resume skip -n (claude picks up
# stored name from transcript). On a fresh session keep the default "ccairgap".
if [ -n "${CCAIRGAP_NAME:-}" ]; then
    NAME_ARGS=(-n "$CCAIRGAP_NAME")
elif [ -n "${CCAIRGAP_RESUME:-}" ]; then
    NAME_ARGS=()
else
    NAME_ARGS=(-n "ccairgap")
fi

RESUME_ARGS=()
if [ -n "${CCAIRGAP_RESUME:-}" ]; then
    RESUME_ARGS=(-r "$CCAIRGAP_RESUME")
fi

if [ -n "${CCAIRGAP_PRINT:-}" ]; then
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}" "${RESUME_ARGS[@]}" -p "$CCAIRGAP_PRINT"
else
    exec claude --dangerously-skip-permissions "${NAME_ARGS[@]}" "${RESUME_ARGS[@]}"
fi
```

### Exit handoff

No changes. `handoff.ts:225-240` already copies `$SESSION/transcripts/<encoded>/` into `~/.claude/projects/<encoded>/` merging by file. The resumed `<uuid>.jsonl` (now longer) overwrites the host copy cleanly; subagents merge by filename.

**Idempotency note:** if handoff runs before any new turn, the copy-back writes back an identical `<uuid>.jsonl` — safe.

### Launch flow diff (SPEC §Launch flow)

New step between current 9 (create `$SESSION/transcripts/`) and 10 (resolve symlinks):

> 9a. If `--resume <uuid>` was passed: locate `~/.claude/projects/<encoded-workspace-cwd>/<uuid>.jsonl` and its sibling `<uuid>/` dir. Copy both (if present; the `.jsonl` is required, the dir is optional) into `$SESSION/transcripts/<encoded>/`. If the `.jsonl` source is missing, error and exit before any docker interaction. Extract the latest `agent-name` entry from the source jsonl to pass through as `CCAIRGAP_RESUME_ORIG_NAME` when `--name` is not explicit.

## Data layout clarification (SPEC fix)

`docs/SPEC.md` §Transcripts line 508 is wrong. Actual layout on host:

```
~/.claude/projects/<encoded-cwd>/
├── <session-uuid>.jsonl              # main transcript (flat file)
├── <session-uuid>/subagents/*.jsonl  # subagent transcripts (sibling dir)
└── permissions_log.jsonl             # per-project, cross-session
```

SPEC currently claims `<session-uuid>/*.jsonl plus nested <session-uuid>/subagents/*.jsonl`. Fix to reflect the flat + sibling layout. This fix is part of this change.

## Host writable paths invariant

Unchanged. Resume adds a read from `~/.claude/projects/<encoded>/` and an additional pre-launch write into `$SESSION/transcripts/` (already a scratch path). Exit-trap copy-back to `~/.claude/projects/<encoded>/` already exists in the writable set (item 3 of §"Host writable paths"). No new write path.

## CLI code surface

- `src/cli.ts`:
  - Add option `-r, --resume <session-id>`.
  - Thread through `mergeRun` (scalar: CLI overrides config).
  - Pass to `launch()` as `resume?: string`.
- `src/launch.ts`:
  - Add `resume?: string` to `LaunchOptions`.
  - Reject under `--bare` / no workspace repo with the error message above.
  - After `mkdirSync($SESSION/transcripts)`, call new helper `copyInResume({ sessionDir, hostClaudeDir, workspaceHostPath, uuid })` that does the cp and returns the extracted original name.
  - Append two `-e CCAIRGAP_RESUME=<uuid>` / `-e CCAIRGAP_RESUME_ORIG_NAME=<name>` docker args when set.
- `src/resume.ts` (new):
  - `copyInResume(...)` — cp + name extraction, returns `{ origName?: string }`.
  - Tests: missing source, flat jsonl only, flat jsonl + subagents dir, name extraction (present / absent / malformed line mid-file).
- `src/config.ts`:
  - Accept `resume` key (scalar string). Validate as string. Not path-resolved — it's a UUID.
- `docker/entrypoint.sh`: changes above.
- `docs/SPEC.md`:
  - §Transcripts layout fix.
  - §Launch flow step 9a.
  - §"CLI surface" table row for `--resume`.
  - §Host env vars: add `CCAIRGAP_RESUME`, `CCAIRGAP_RESUME_ORIG_NAME` (or list under container env — they're set by CLI, consumed by entrypoint).
- `README.md`:
  - Flag row + a short example: `ccairgap -r <uuid>`.

## Testing

- **`src/resume.test.ts`** (unit):
  - Copies flat jsonl only (no subagents dir) successfully.
  - Copies flat jsonl + subagents dir successfully.
  - Throws clear error when source jsonl missing.
  - Extracts most recent `agent-name` when multiple present.
  - Returns `undefined` when no `agent-name` entry.
  - Returns `undefined` when jsonl has malformed lines mid-file (skip-and-continue).
- **`src/config.test.ts`** (extend):
  - `resume` key accepted and passes through.
  - CLI overrides config.
- **`src/cli.test.ts`** / integration: not changing existing suites; add a smoke test only if the pattern exists (check before adding).
- **No docker-level test.** The entrypoint changes are shell plumbing; manual verification with a real session before merge.

## Manual verification checklist

Before merge:

1. Create a host session, note its UUID, exit.
2. `ccairgap -r <uuid>` in the same repo → session resumes, previous context visible, prompt box shows `[ccairgap] <original-name>`.
3. `ccairgap -r <uuid> -n renamed` → prompt box shows `[ccairgap] renamed`; host jsonl, after exit, has a new `agent-name` entry with `agentName: "renamed"`.
4. `ccairgap -r bogus-uuid` → exits 1 with the not-found error, no session dir left behind.
5. `ccairgap --bare -r <uuid>` → exits 1 with the bare-mode error.
6. Start a fresh ccairgap session, exit, then `ccairgap -r <that-uuid>` → resumes in the same mechanism (one unified path, regardless of origin).
7. Resume a session with subagent transcripts, spawn another subagent, exit → host subagents dir has both old and new files.

## Decisions

- **Size warning**: large jsonls (100MB+) have noticeable copy cost. Not worth warning about for v1; revisit if it surfaces as a complaint.
- **Name extraction cost**: reverse-iterate + `JSON.parse` until first `agent-name` match. Fine for current transcript sizes. Switch to a regex pre-filter only if profiling surfaces this as a bottleneck.

## Out of scope, for a future spec

- Interactive picker mode (`ccairgap -r` no arg).
- Resume from container's `/resume` TUI.
- Auto-pull of `todos/`, `shell-snapshots/`, `file-history/` for the resumed session.
- `--fork-session` passthrough (claude flag that creates a new sessionId from a resumed transcript).
