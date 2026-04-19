### Task 7: Update `docs/SPEC.md`, `README.md`, `CLAUDE.md`, and skill references

**Depends on:** Task 6
**Commit:** implementer
**Files:**
- Modify: `/Users/alfredvc/src/ccairgap/docs/SPEC.md`
- Modify: `/Users/alfredvc/src/ccairgap/README.md`
- Modify: `/Users/alfredvc/src/ccairgap/CLAUDE.md`
- Modify: `/Users/alfredvc/src/ccairgap/SECURITY.md`
- Modify: `/Users/alfredvc/src/ccairgap/skills/ccairgap-configure/references/config-schema.md`
- Modify: `/Users/alfredvc/src/ccairgap/skills/ccairgap-configure/references/docker-run-args.md`
- Modify: `/Users/alfredvc/src/ccairgap/skills/ccairgap-configure/references/artifact-decision.md`

SPEC first (per project convention), then README, then inline docs.

#### Steps:

- [ ] **Step 1: Add "Session identifier" section to SPEC**

Open `docs/SPEC.md`. Find the section around line 54 that currently reads:

```markdown
- `<ts>` is ISO 8601 compact, e.g. `20260417T143022Z`.
```

Replace with:

```markdown
- `<id>` is the session identifier. Generated as `<prefix>-<4hex>` where:
  - **prefix** is `--name <name>` if the user passed one, otherwise a random
    `<adj>-<noun>` pair drawn from the bundled word list in `src/sessionId.ts`.
  - **4hex** is always appended (via `crypto.randomBytes`) so collisions are
    rare even for fixed prefixes (65536 combos per prefix).
- The id drives four things uniformly: session dir (`$XDG_STATE_HOME/ccairgap/sessions/<id>`),
  docker container (`ccairgap-<id>`), sandbox branch (`ccairgap/<id>`), and
  Claude's session label (`-n "ccairgap <id>"`, rewritten to `[ccairgap] <id>`
  by the rename hook on first prompt).
- On collision with any of session dir / running-or-stopped container / workspace
  branch, the hex suffix is re-rolled up to 8 times before aborting.
- Validated once via `git check-ref-format refs/heads/ccairgap/<id>`; a bad
  `--name` surfaces before any filesystem side effects.
```

- [ ] **Step 2: Replace `<ts>` with `<id>` throughout SPEC (mechanical substitution)**

Use the Edit tool with `replace_all: true` on `docs/SPEC.md` to replace the literal string `<ts>` with `<id>`. This is safe because `<ts>` is never used to mean "timestamp example" in SPEC — the one explicit timestamp example (`20260417T143022Z`) appears without the angle-bracket placeholder and is replaced separately by Step 1 above.

After the replace, grep to confirm zero `<ts>` remain:

```bash
grep -n "<ts>" docs/SPEC.md
```
Expected: no output.

- [ ] **Step 3: SPEC prose rewrites (semantic, not mechanical)**

Three SPEC passages describe the **mechanics** of branch naming, the `-n` flag, and the `CCAIRGAP_NAME` env var. After the mechanical substitution in Step 2, these now say `<id>` but the surrounding prose still describes the old two-flag model (`ts` default vs. `--name` override). Rewrite each in place.

**Passage 1** — §"Launch sequence" step 7 (around `docs/SPEC.md:155`). Find:

```markdown
   - `<branch>` is `ccairgap/<id>` by default, or `ccairgap/<--name>` when `--name` was passed. The name is validated (`git check-ref-format refs/heads/<branch>`) and checked for collision on the workspace repo (`--repo`) before side effects.
```

Replace with:

```markdown
   - `<branch>` is always `ccairgap/<id>` where `<id>` is `<prefix>-<4hex>` per §"Session identifier". `--name` supplies the prefix; omitted, a random `<adj>-<noun>` prefix is used. The full ref (`refs/heads/ccairgap/<prefix>-<4hex>`) is validated once via `git check-ref-format`; on collision with an existing session dir, container, or branch in the workspace repo (`--repo`), the hex suffix is re-rolled (up to 8 attempts) before aborting.
```

**Passage 2** — §"Entrypoint" / container-side claude args step 9 (around `docs/SPEC.md:430`). Find:

```markdown
9. Build the final `claude` args: always `--dangerously-skip-permissions`; `-n "ccairgap"` by default, or `-n "$CCAIRGAP_NAME"` when the env var is set, to seed the `/resume` label and terminal title. Note the `-n` value is intentionally *not* prefixed with `[ccairgap]`: a UserPromptSubmit hook injected by the entrypoint emits `sessionTitle: "[ccairgap]"` (or `"[ccairgap] $CCAIRGAP_NAME"`) on first prompt, and Claude Code's hook layer dedups against the current title — so if `-n` already matched the hook output, the rename would skip and the TUI's "session renamed" side effects (TextInput border recolor, top-border label) would never fire. Then either `-p "$CCAIRGAP_PRINT"` for non-interactive print mode, or nothing for the interactive REPL. `exec claude …`.
```

Replace with:

```markdown
9. Build the final `claude` args: always `--dangerously-skip-permissions`; `-n "ccairgap $CCAIRGAP_NAME"` (CCAIRGAP_NAME carries the session id `<prefix>-<4hex>` from the CLI and is always set; the fallback `-n "ccairgap"` only runs when the entrypoint is executed directly outside the CLI). The `-n` value is intentionally **not** prefixed with `[ccairgap]`: a UserPromptSubmit hook injected by the entrypoint emits `sessionTitle: "[ccairgap] $CCAIRGAP_NAME"` on first prompt, and Claude Code's hook layer dedups against the current title — so if `-n` already matched the hook output, the rename would skip and the TUI's "session renamed" side effects (TextInput border recolor, top-border label) would never fire. Then either `-p "$CCAIRGAP_PRINT"` for non-interactive print mode, or nothing for the interactive REPL. `exec claude …`.
```

**Passage 3** — §"Environment variables" `CCAIRGAP_NAME` row (around `docs/SPEC.md:710`). Find:

```markdown
| `CCAIRGAP_NAME` | `--name` | Session display name; forwarded to `claude -n <name>` in the entrypoint. Unset when `--name` was not passed. |
```

Replace with:

```markdown
| `CCAIRGAP_NAME` | session id | Always set. Carries `<prefix>-<4hex>` from the CLI. Used by the entrypoint to build `-n "ccairgap $CCAIRGAP_NAME"` and by the UserPromptSubmit rename hook to emit `[ccairgap] $CCAIRGAP_NAME`. |
```

- [ ] **Step 4: Add collision-probability note to §"Known constraints"**

Find the §"Known constraints" bullet (around `docs/SPEC.md:770`) that reads:

```markdown
- **Single concurrent session per host recommended.** Multiple simultaneous sessions work but share `$XDG_STATE_HOME/ccairgap/output/`. Sessions don't overlap on `<id>` so repo clones are fine.
```

Replace with:

```markdown
- **Single concurrent session per host recommended.** Multiple simultaneous sessions work but share `$XDG_STATE_HOME/ccairgap/output/`. Ids are `<prefix>-<4hex>`; per §"Session identifier" the hex suffix is randomized so concurrent sessions with the same prefix have a 1/65536 collision probability per pair. On collision, the second `docker run` fails cleanly and the CLI aborts with a message; no half-created state remains beyond the session dir, which `ccairgap discard <id>` clears.
```

- [ ] **Step 5: Update `README.md`**

Grep for the current occurrences to confirm the sites before editing:

```bash
grep -n "<ts>" README.md
```
Expected: 10 lines (17, 21, 97, 108, 123, 127, 129, 135, 277, 278).

Apply these edits one at a time — do **not** run a blind file-wide replace, because the `-n, --name` table row's `<ts>` appears in a different context than the others.

**Edit 1** — `-n, --name` table row (line 135). Find:

```markdown
| `-n, --name <name>` | `<ts>` | no | Session name. Branch becomes `ccairgap/<name>`; forwarded as Claude's session label. Aborts on invalid git ref or branch collision. See notes below. |
```

Replace with:

```markdown
| `-n, --name <name>` | random `<adj>-<noun>` | no | Session id **prefix**. The CLI always appends a 4-hex suffix; the final id is `<name>-<4hex>`. Drives the session dir, docker container (`ccairgap-<id>`), branch (`ccairgap/<id>`), and Claude's session label (`[ccairgap] <id>`). Must be a valid git ref component. See notes below. |
```

**Edit 2** — "Notes on `--name`" paragraph (line 144). Find:

```markdown
The initial `claude -n "<name>"` sets the session label, then on the first user prompt a hook renames the session to `[ccairgap] <name>` (or `[ccairgap]` when unset). That relabeled form is what `/resume` and the TUI's top-border label show. The two-step rename is intentional — matching labels would trigger Claude Code's hook-dedup and skip the TUI rename effect.
```

Replace with:

```markdown
The initial `claude -n "ccairgap <id>"` sets the session label, then on the first user prompt a hook renames the session to `[ccairgap] <id>`. That relabeled form is what `/resume` and the TUI's top-border label show. The two-step rename is intentional — matching labels would trigger Claude Code's hook-dedup and skip the TUI rename effect. `--name` supplies only the **prefix**; the hex suffix is always appended so two launches with the same `--name` never collide on branch, container, or session dir.
```

**Edit 3** — "On exit" git-log example (line 102). Find:

```bash
$ git log --oneline ccairgap/20260418T143022Z
a3f1b2c Wire auth middleware
b4e2d8f Add login route
```

Replace with:

```bash
$ git log --oneline ccairgap/fuzzy-otter-a4f1
a3f1b2c Wire auth middleware
b4e2d8f Add login route
```

**Edit 4** — remaining `<ts>` → `<id>` substitutions. These eight sites are pure placeholder swaps and the surrounding prose does not need rewriting. For each, use Edit with the exact context below:

| Line | Before | After |
|------|--------|-------|
| 17 | `land as \`ccairgap/<ts>\` in your repo.` | `land as \`ccairgap/<id>\` in your repo.` |
| 21 | `the \`ccairgap/<ts>\` branch via \`git fetch\`` | `the \`ccairgap/<id>\` branch via \`git fetch\`` |
| 97 | `Claude's commits land as \`ccairgap/<ts>\` in each repo:` | `Claude's commits land as \`ccairgap/<id>\` in each repo:` |
| 108 | `then \`ccairgap discard <ts>\`.` | `then \`ccairgap discard <id>\`.` |
| 123 | `branch \`ccairgap/<ts>\` created on exit.` | `branch \`ccairgap/<id>\` created on exit.` |
| 127 | `\`$CCAIRGAP_HOME/output/<ts>/<abs-src>/\`.` | `\`$CCAIRGAP_HOME/output/<id>/<abs-src>/\`.` |
| 129 | `Base ref for \`ccairgap/<ts>\`.` | `Base ref for \`ccairgap/<id>\`.` |
| 277 | `\`recover [<ts>]\` ... With no \`<ts>\`, falls back to \`list\`.` | `\`recover [<id>]\` ... With no \`<id>\`, falls back to \`list\`.` |
| 278 | `\`discard <ts>\` \| Delete a session dir` | `\`discard <id>\` \| Delete a session dir` |

After all edits, `grep -n "<ts>" README.md` must return no output.

- [ ] **Step 6: Update `CLAUDE.md`**

Find:

```markdown
- **Host writable paths are closed set** (SPEC §"Host writable paths"): session scratch, `output/`, `~/.claude/projects/<encoded>`, and `ccairgap/<ts>` ref via `git fetch` on exit. Adding any other write path requires SPEC update.
```

Replace with:

```markdown
- **Host writable paths are closed set** (SPEC §"Host writable paths"): session scratch, `output/`, `~/.claude/projects/<encoded>`, and `ccairgap/<id>` ref via `git fetch` on exit. Adding any other write path requires SPEC update.
```

Find:

```markdown
- **Exit trap is best-effort.** SIGKILL of CLI leaves session on disk; user runs `ccairgap recover <ts>`. Handoff must stay idempotent.
```

Replace with:

```markdown
- **Exit trap is best-effort.** SIGKILL of CLI leaves session on disk; user runs `ccairgap recover <id>`. Handoff must stay idempotent.
```

- [ ] **Step 7: Update `SECURITY.md`**

Find:

```markdown
- Real git repositories passed via `--repo` / `--extra-repo` (only `ccairgap/<ts>` ref creation via host-side `git fetch` on exit is permitted).
```

Replace with:

```markdown
- Real git repositories passed via `--repo` / `--extra-repo` (only `ccairgap/<id>` ref creation via host-side `git fetch` on exit is permitted).
```

- [ ] **Step 8: Update skill references**

In `skills/ccairgap-configure/references/config-schema.md`, find the `name` row:

```markdown
| `name` | string | `-n` / `--name` | Session name; branch becomes `ccairgap/<name>`. |
```

Replace with:

```markdown
| `name` | string | `-n` / `--name` | Session id prefix; final id is `<name>-<4hex>`. Branch becomes `ccairgap/<id>`. |
```

Also replace any other `<ts>` occurrences in this file with `<id>`.

In `skills/ccairgap-configure/references/docker-run-args.md`, find:

```markdown
docker run --rm -it --cap-drop=ALL --name ccairgap-<ts> \
```

Replace with:

```markdown
docker run --rm -it --cap-drop=ALL --name ccairgap-<id> \
```

Find:

```markdown
- `--name <custom>` overrides `ccairgap-<ts>` — almost always a bad idea; breaks `ccairgap list` and orphan detection.
```

Replace with:

```markdown
- `--name <custom>` overrides `ccairgap-<id>` — almost always a bad idea; breaks `ccairgap list` and orphan detection.
```

In `skills/ccairgap-configure/references/artifact-decision.md`, replace all four `<ts>` occurrences with `<id>`.

- [ ] **Step 9: Final grep sweep**

Run: `grep -rn "<ts>" docs/ README.md CLAUDE.md SECURITY.md skills/` (via Grep tool)
Expected: zero occurrences outside of `docs/research/` (research docs are historical, leave them).

- [ ] **Step 10: Commit**

```bash
git add docs/SPEC.md README.md CLAUDE.md SECURITY.md skills/ccairgap-configure/references/
git commit -m "docs: replace <ts> with <id> session-identifier nomenclature"
```

---

