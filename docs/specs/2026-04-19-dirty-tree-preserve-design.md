# Dirty Working Tree Preserve on Handoff — Design Spec

**Status:** Draft — awaiting user approval
**Date:** 2026-04-19
**Author:** ccairgap maintainers

## Problem

Today, if a ccairgap session exits with uncommitted changes in any session clone
(edits in working tree, staged-but-uncommitted hunks, or new untracked files),
the handoff routine silently deletes them.

Concretely:

- Graceful Ctrl-C → `claude` exits → `docker run` returns → `handoff()` runs →
  no commits on `ccairgap/<id>` → no orphan side-branch → session dir
  `rm -rf`'d → **dirty working tree gone, unrecoverable.**
- Hard kill (terminal closed, SIGHUP on the CLI) → session dir persists on
  disk, but the first `ccairgap recover <id>` the user runs executes the same
  handoff logic and wipes the working tree for the same reason.

The only existing safety net (`orphanBranches` check in `handoff.ts:46-85`)
triggers exclusively on committed work sitting on non-sandbox local branches.
It does nothing for a dirty working tree, which is the common case for a
user who Ctrl-C's mid-task.

This is a silent data-loss bug, not a recoverable one.

## Goal

Treat a dirty working tree in any session clone as work worth preserving.
Extend the existing session-preservation mechanism (currently
orphan-branch-only) to also fire on a dirty working tree. Adds one opt-out
flag (`--no-preserve-dirty` / config key) for scripted callers who
explicitly accept the loss; no new subcommands, no manifest changes.

## Non-goals

- Auto-commit or auto-stash on exit. Mutating the user's repo state without
  consent is out of scope.
- Interactive prompts on exit. The exit trap runs after the terminal is
  already gone in the hard-kill case; it must stay fully non-interactive.
- Cleanup automation (age-based purge, disk-quota enforcement). Users manage
  preserved sessions via the existing `list` / `discard` commands.
- Changing what handoff harvests (commits, transcripts, `--sync` artifacts).
  Only the final `rm -rf` gets a new guard.
- Preserving edits to files matched by `.gitignore`. If Claude edits
  `.env.local` or similar, those changes are lost on exit. Workaround:
  launch with `--sync <path>`. Explicitly scoped out — the spec's
  preservation claim is "tracked changes + new untracked files not
  matched by `.gitignore`", not "every byte the container wrote."
- Closing the adjacent gap where committed work on non-sandbox local
  branches is silently lost **when the sandbox branch also has commits**.
  The current orphan-branch preservation only fires when sandbox is
  empty. This spec does not change that. Tracked as a separate issue;
  scoped out of this change to keep the diff focused.
- `recover --json` or other machine-readable output.

## User-facing behavior

### Scenario: graceful Ctrl-C with uncommitted edits

User is mid-task, Ctrl-C's Claude. Container exits cleanly.

What user sees on stderr from the exit trap:

```
[handoff] <host-repo-path>: uncommitted changes in session clone (3 tracked-file changes, 1 untracked entry).
[handoff] Your uncommitted work is at:
[handoff]   /Users/alice/.local/state/ccairgap/sessions/fuzzy-otter-a4f1/repos/myapp-3c2f1b8d
[handoff]
[handoff] To save the work:
[handoff]   cd <path above>
[handoff]   git status                    # see what's there
[handoff]   git add -A && git commit      # commit what you want
[handoff]   ccairgap recover fuzzy-otter-a4f1
[handoff]
[handoff] To drop the work: ccairgap discard fuzzy-otter-a4f1
[handoff]
[handoff] If this preservation is unintended (e.g. build artifacts from
[handoff] `npm install` / `pytest` / etc.), the fix is to add those paths
[handoff] to your repo's .gitignore. Scripted callers can pass
[handoff] --no-preserve-dirty to skip this check entirely.
```

Session dir stays on disk. Transcripts and `--sync` copy-out still ran
normally — those are always safe. The launch exit code is unchanged
(docker run's exit code propagates through as before); handoff warnings
are stderr-only.

**"Untracked entries" count caveat:** `git status --porcelain` emits
one line per untracked directory, not per file inside it. So "1 untracked
entry" may mean a single `node_modules/` containing thousands of files.
The message uses "entry" not "file" to be honest about this.

### Scenario: combined trigger (dirty + orphan branch)

If a session has both a dirty working tree **and** commits on a
non-sandbox local branch, the warning names both preservation reasons
and **omits the `discard` hint** — discarding would lose the
orphan-branch commits. Example:

```
[handoff] <host-repo-path>: uncommitted changes (2 tracked-file changes).
[handoff] <host-repo-path>: local branch `feature/auth` has 3 commits not on origin.
[handoff] Your uncommitted work is at:
[handoff]   /Users/alice/.local/state/ccairgap/sessions/fuzzy-otter-a4f1/repos/myapp-3c2f1b8d
[handoff]
[handoff] This session has BOTH uncommitted work AND committed work on
[handoff] side branches. Inspect and rescue both before running
[handoff] `ccairgap discard <id>` — discard is unsafe until side-branch
[handoff] commits have been preserved.
```

### Scenario: scan failure (corrupt session clone)

If `git status --porcelain` errors (e.g. `.git/` corrupted mid-kill), the
warning names the git error and points at `discard` — `git status`
instructions would just re-fail:

```
[handoff] <host-repo-path>: could not scan session clone (git error: `fatal: not a git repository`).
[handoff] State is unknown. Session preserved out of caution.
[handoff]
[handoff] Inspect manually at:
[handoff]   /Users/alice/.local/state/ccairgap/sessions/fuzzy-otter-a4f1/repos/myapp-3c2f1b8d
[handoff]
[handoff] If there is nothing to rescue: ccairgap discard fuzzy-otter-a4f1
```

### Scenario: hard kill (terminal closed), then recover

Session dir already persisted by accident. User runs:

```
ccairgap recover fuzzy-otter-a4f1
```

`recover` calls the same handoff, which detects the dirty tree and prints
the same message as above. Session dir stays preserved. No data loss.

### Scenario: user commits, then recovers

User follows the instructions from the warning:

```
cd ~/.local/state/ccairgap/sessions/fuzzy-otter-a4f1/repos/myapp-3c2f1b8d
git add -A
git commit -m "WIP: auth middleware"
ccairgap recover fuzzy-otter-a4f1
```

`recover` runs handoff again. Sandbox branch now has a commit →
`gitFetchSandbox` moves it onto the host repo as
`ccairgap/fuzzy-otter-a4f1`. Dirty tree now clean → `preserved=false` →
session dir removed. Output:

```
recovered fuzzy-otter-a4f1: 1 fetched, 0 empty, 0 failed, 1 transcript dirs copied, session dir removed
```

### Scenario: user wants to throw it away

```
ccairgap discard fuzzy-otter-a4f1
```

Existing behavior — unchanged. `rm -rf` session dir, no handoff. Use this
when the dirty work is junk.

## Design: what counts as "dirty"?

**Definition:** A session clone is **dirty** if `git status --porcelain` emits
any non-empty output (after normal `.gitignore` processing).

This includes:

- Modified tracked files (`M`, `MM`, `AM`, etc.)
- Staged-but-uncommitted hunks (`A`, `D`, `R`, …)
- Untracked files not matched by `.gitignore` (`??`)

It **excludes** files matched by `.gitignore` — `node_modules/`, `.venv/`,
`dist/`, `.DS_Store` under a well-configured ignore set, etc. If the user's
`.gitignore` is incomplete, untracked build junk triggers preservation.

**Failure-cost framing:** data-loss cost is unbounded (false-delete loses
potentially hours of work, unrecoverable). False-preserve is bounded:
disk space, lingering macOS `$SESSION/creds/.credentials.json`, and user
attention from each warning. The design trades the bounded cost for the
unbounded one. It does not claim preservation is free.

Design consequences:

- **Repeated false-preserves** are a signal the user's `.gitignore` is
  incomplete. The warning names the preserved path and explicitly points
  at `.gitignore` as the fix. Users self-correct.
- **No curated denylist** of "probably-junk" paths (e.g. `node_modules/`,
  `target/`) maintained by ccairgap. That would require ongoing
  maintenance and still diverge from user intent in edge cases.
- **Opt-out via `--no-preserve-dirty`** for scripted callers who
  knowingly accept the data-loss tradeoff (CI loops, `-p` smoke tests
  with throwaway artifacts). Default remains preserve — interactive use
  must not lose work without consent.

**Per-repo scan, union across repos.** Each `manifest.repos[]` entry has its
session clone scanned independently. If *any* one repo is dirty, the entire
session dir is preserved (we cannot partially `rm`). Warnings name each
dirty repo with its counts.

## New opt-out flag

**`--no-preserve-dirty`** (launch flag, boolean, default off) and
corresponding config key `no-preserve-dirty: true` / `noPreserveDirty:
true`. When set, the dirty-tree scan still runs, but a `dirty` result
no longer triggers preservation. Orphan-branch preservation and
scan-failure preservation still fire — the scan stays active so
unknown-state (scan failure) can still err on preserve.

Intended use: CI loops, smoke tests, any scripted `-p` invocation where
the user has accepted that uncommitted artifacts from `npm install` /
`pytest` / etc. are disposable. Documented as such in README and SPEC.

Not plumbed into `recover` — recover always runs full handoff; the flag
only affects the exit-trap launch path. Rationale: `recover` is an
explicit user action on a session that already exists; there is no
scripted/unattended path through it.

## Handoff changes

**File:** `src/handoff.ts`

Add a `dirtyTree()` helper alongside `sandboxCommitCount` and
`orphanBranches`. Returns `{ modified: number, untracked: number } | null`
(null = clean).

```ts
type DirtyStatus =
  | { kind: "clean" }
  | { kind: "dirty"; modified: number; untracked: number }
  | { kind: "scan-failed"; error: string };

async function dirtyTree(sessionClone: string): Promise<DirtyStatus> {
  try {
    const { stdout } = await execa("git", [
      "-C",
      sessionClone,
      "status",
      "--porcelain",
    ]);
    const lines = stdout.split("\n").filter((l) => l.length > 0);
    if (lines.length === 0) return { kind: "clean" };
    let modified = 0;
    let untracked = 0;
    for (const l of lines) {
      if (l.startsWith("??")) untracked++;
      else modified++;
    }
    return { kind: "dirty", modified, untracked };
  } catch (e) {
    return { kind: "scan-failed", error: (e as Error).message };
  }
}
```

**Call site:** inside the per-repo loop in `handoff()` (`handoff.ts:149`),
**after** the alternates rewrite (required so git can traverse history
for any follow-on ops the user may run from the warning) and
**independently** of the `sandboxCount === 0` branch. Dirty-tree detection
must run for every repo, not just empty-sandbox ones. Skipped only when
the caller passes `noPreserveDirty: true` (wired via
`--no-preserve-dirty`).

**Ordering invariant:** the alternates rewrite → dirty scan order must
be preserved across future refactors. Both SPEC.md §"Handoff routine"
and the new CLAUDE.md invariant line call this out.

**Preservation wiring:** currently `preserved = true` is set only inside the
orphan-branch branch (`handoff.ts:181`). Generalize: accumulate two
parallel lists inside the repo loop — `dirtyRepos: Array<{ repo: string;
modified: number; untracked: number }>` and `orphanRepos: Array<{ repo:
string; branches: Array<{ branch: string; count: number }> }>`. A third
list `scanFailedRepos: string[]` captures repos whose dirty scan errored
(see failure policy below). Set `preserved = true` iff any of the three is
non-empty. The existing terminal `if (preserved) … else rm …` block at
`handoff.ts:242-253` is unchanged.

**Scan-failure policy:** when `dirtyTree()` returns `{ kind: "scan-failed"
}`, the repo is added to `scanFailedRepos` and treated as a preservation
trigger. The premise of this feature is asymmetric failure costs (false
preserve = recoverable, false delete = unrecoverable); an unknown state
means we err on preserve. The warning names the repo and includes the git
error for diagnosis.

**Warning emission:** move from inline `warnings.push(...)` in the orphan
branch to a single post-loop block that formats the preservation reasons
into a multi-line message with the exact `cd` path, `recover <id>` and
`discard <id>` next steps. See §"User-facing behavior" above for the
canonical copy — three distinct shapes: dirty-only, combined
(dirty + orphan), and scan-failed. The combined shape omits the
`discard` hint (discarding would lose orphan-branch commits).

**Transcripts + `--sync` copy-out:** unchanged. Still run every handoff,
still idempotent, regardless of dirty state.

**Container-live precheck in `recover`:** before running handoff,
`recover(id)` in `src/subcommands.ts:52` must check `docker ps` for a
running `ccairgap-<id>` container. If present, abort with a clear error:

```
ccairgap: session <id> has a running container (ccairgap-<id>).
  Stop it first: docker stop ccairgap-<id>
  Or let it exit normally — the exit trap will run handoff.
```

Rationale: running handoff against a live session races with the
container's writes. `ccairgap list` already filters live sessions out
(see `orphans.ts`); `recover` should match. This is a behavior change
for the `recover` subcommand — previously it ran unconditionally. Called
out explicitly in SPEC §"Recovery" + README subcommand row.

## `ccairgap list` changes

**File:** `src/orphans.ts`

Currently `scanOrphans` returns commit counts per repo. Extend to include
dirty counts too:

```ts
interface OrphanInfo {
  id: string;
  repos: string[];
  commits: Record<string, number>;          // existing
  dirty: Record<string, { modified: number; untracked: number }>; // new
}
```

`list` output gains a `dirty=<repo>+<M>M/<U>U` segment when non-empty:

```
fuzzy-otter-a4f1  repos=myapp  commits=myapp+0  dirty=myapp+3M/1U
```

This is the only other surface change. `doctor` is not modified.

## Documentation updates

### `docs/SPEC.md`

1. **§"Host writable paths"** (line 69) — no change. The writable set is
   unchanged; we're only changing when the session dir is deleted vs.
   preserved.

2. **§"Handoff routine"** (line 762) — update step 5. Current text:

   > 5. If any repo had an `empty` sandbox branch **and** any other local
   > branch in that session clone carries commits not reachable from
   > `origin/*`, **preserve the session dir** …

   New text covers both triggers:

   > 5. **Preserve session dir** (skip step 6) if **any** of the following
   > holds for **any** repo in the manifest:
   >   - The session clone's working tree is dirty (`git status
   >     --porcelain` non-empty, `.gitignore` respected). Runs after
   >     step 2's alternates rewrite — ordering must be preserved.
   >     Skipped entirely when the caller passes `--no-preserve-dirty`.
   >   - The dirty-tree scan failed (uncertainty → err on preserve).
   >   - The sandbox branch is empty **and** another local branch carries
   >     commits not reachable from `origin/*`.
   >
   > The warning emitted names every preservation trigger (dirty repos
   > with their modified/untracked counts, scan-failed repos with their
   > git error, orphan branches with their commit counts) and tells the
   > user the exact `cd` path and `ccairgap recover <id>` next step.
   > `ccairgap discard <id>` is offered as an exit only when safe —
   > suppressed when orphan-branch commits would be lost.
   >
   > Known limitation: edits to files matched by `.gitignore` (e.g.
   > `.env.local`) are not detected and are lost on exit. Workaround:
   > launch with `--sync <path>`.

3. **§"Recovery"** (line 789) — add two paragraphs after the existing
   description of `recover`:

   > If the session contains a dirty working tree or orphan-branch
   > commits, `recover` does not delete the session dir — it re-emits the
   > same preservation warning. Commit or discard the work in the session
   > clone (paths printed in the warning), then re-run `ccairgap recover
   > <id>` to finalize.
   >
   > `recover <id>` refuses to run against a session whose container is
   > still running (checked via `docker ps` for `ccairgap-<id>`). Stop
   > the container with `docker stop ccairgap-<id>` first, or let it
   > exit normally — the exit trap will run handoff.

### `README.md`

1. **Line 100-111** ("When the session ends, Claude's commits land as
   `ccairgap/<id>`") — extend the bullet list:

   ```
   - **No commits** → no branch created.
   - **Commits on a side branch only** → session dir preserved. Inspect,
     recover what you need, then `ccairgap discard <id>`.
   - **Uncommitted edits to tracked files, or new untracked files not
     matched by `.gitignore`** → session dir preserved. Warning tells
     you where to `cd`, commit, and re-run `ccairgap recover <id>`. Edits
     to files matched by `.gitignore` (e.g. `.env.local`) are **not**
     preserved — use `--sync <path>` at launch if you need them.
   - **Scripted / CI use** → pass `--no-preserve-dirty` to skip the
     dirty-tree check entirely. Trade-off: uncommitted edits are lost
     on exit; build artifacts don't accumulate preserved sessions.
   ```

2. **Launch flags table** — add `--no-preserve-dirty` row:

   ```
   | `--no-preserve-dirty` | off | no | Skip the dirty-working-tree
   preservation check on exit. Intended for scripted / CI use where
   uncommitted container-side edits are disposable (e.g. `npm install`
   artifacts). Orphan-branch and scan-failure preservation still fire. |
   ```

3. **Subcommands table row for `recover`** (line 291) — extend
   description to note the live-container precheck:

   ```
   recover [<id>] — Run handoff (fetch sandbox branch, copy transcripts,
   rm session dir if clean). Idempotent. Preserves session on dirty
   tree, orphan-branch commits, or scan failure — commit or discard the
   work, then re-run. Aborts if the container is still running; stop it
   first. With no <id>, falls back to `list`.
   ```

### `CLAUDE.md`

Add two bullets to §"Non-obvious invariants":

> - **Handoff preserves session dir on dirty working tree or scan
>   failure.** `handoff()` treats any `git status --porcelain` non-empty
>   output (per-repo) **or** any scan error as a preservation trigger,
>   in addition to the existing orphan-branch logic. The final `rm -rf`
>   is gated on all three conditions being absent. The dirty scan runs
>   **after** the alternates rewrite in the per-repo loop — both steps
>   must stay in that order across refactors. Applies to both
>   exit-trap and `ccairgap recover` paths; `--no-preserve-dirty` /
>   config key `no-preserve-dirty: true` opts the dirty trigger out for
>   scripted callers (orphan + scan-failure still fire).
> - **`recover <id>` refuses to run against a live container.** Pre-handoff
>   check: `docker ps --filter name=^/ccairgap-<id>$ --format '{{.ID}}'`
>   non-empty → abort with a message telling the user to `docker stop`
>   or let the session exit normally. Required because the dirty scan
>   and (existing) `git fetch` would race with container writes.

## Additional out-of-scope items

(Not already covered in §"Non-goals" above.)

- Stopping a still-running container on recover. Recover aborts with a
  clear message; the user decides whether to stop or let it exit.
- Configurable ignore-list beyond `.gitignore`.
- Preserving non-repo scratch (`$SESSION/creds`, `$SESSION/hook-policy`,
  `$SESSION/policy`) — these are always regenerated and not user work.

## Edge cases

- **Submodules.** `git status --porcelain` surfaces submodule state.
  Dirty submodule preserves the session. Acceptable; rare for ccairgap
  target repos.
- **Ignored but user-edited files.** If a user modifies an ignored file
  (say `.env.local`), `git status --porcelain` does not surface it by
  default and the session would be deleted. Document as a known limitation.
  Workaround: user adds `--sync .env.local` at launch if they want to
  preserve it.
- **Multiple repos, one dirty.** Preserves whole session (correct — can't
  partial-rm). Warning names every dirty repo.
- **Dirty scan fails** (e.g. session clone corrupted mid-kill). Treated as
  a preservation trigger — we don't know whether the tree is clean, and
  the whole point of this feature is to err toward preserve on uncertainty.
  Committed work on the sandbox branch still gets fetched before
  preservation decisions; fetch and preserve are independent.
- **Hard kill while container still running.** `ccairgap recover <id>`
  refuses to run while the container is live (new precheck). User is
  told to `docker stop ccairgap-<id>` or let the container exit
  normally. The exit-trap path is unaffected — it only runs after
  `docker run` returns, so the container is by definition stopped
  when handoff executes in that flow.

## Testing notes (for the plan stage)

Tests should cover:

- Dirty tree (modified only) → preserved, warning emitted, rm skipped.
- Dirty tree (untracked only, not ignored) → preserved.
- Dirty tree (only ignored files) → clean, session removed.
- Dirty tree + committed sandbox → commits fetched AND session preserved.
- Clean tree + committed sandbox → commits fetched, session removed
  (regression guard on the existing path).
- Multi-repo, one dirty → preserved, warning names the dirty one.
- `recover` after a user commits → sandbox fetch, dirty now clean,
  session removed (idempotent recovery path).
- Scan failure (e.g. delete `.git/` from the session clone mid-test) →
  preserved with scan-failed warning; warning names `discard` as exit.
- Combined trigger (dirty + orphan branch) → preserved; warning omits
  `discard` hint.
- `--no-preserve-dirty` flag + `no-preserve-dirty: true` config key:
  dirty tree → session removed (opt-out honored). Orphan branch still
  preserves. Scan failure still preserves.
- `recover <id>` with live container → aborts with clear error, does
  not run handoff.
- `list` shows dirty counts.

All tests use the real `git` binary in a tmp dir (the pattern already used
in the repo's existing handoff tests). No mocking of git.

## Rollout

- No manifest version bump. Schema unchanged.
- One new launch flag (`--no-preserve-dirty`) + config key — additive,
  no existing flag changes.
- `recover <id>` gains a live-container precheck — behavior change, but
  only affects invocations against sessions whose container is still
  running (an undiagnosed-race case today).
- **Exit code**: the launch path's exit code is unchanged — handoff
  preservation warnings go to stderr only; `docker run`'s exit code
  still propagates. `recover` already sets `process.exitCode = 1` on
  any warnings (pre-existing, `subcommands.ts:67`); the new preservation
  triggers inherit that behavior.
- Pre-1.0: ship as `feat:` (minor bump per `.versionrc.json`). Not a
  breaking change — existing invocations that previously `rm`'d a dirty
  session now preserve it, which is strictly safer. The one backward
  compatibility caveat is scripted `recover` callers whose workflow
  previously tolerated running against a live container; those must now
  stop the container first.
