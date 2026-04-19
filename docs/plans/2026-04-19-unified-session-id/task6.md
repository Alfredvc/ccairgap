### Task 6: Update `docker/entrypoint.sh`

**Depends on:** Task 5
**Commit:** implementer
**Files:**
- Modify: `/Users/alfredvc/src/ccairgap/docker/entrypoint.sh`

`CCAIRGAP_NAME` is now always the session id. The initial `claude -n` label becomes `"ccairgap <id>"` (prefix "ccairgap " first — per user decision), the rename-hook rewrite stays `"[ccairgap] $CCAIRGAP_NAME"`. Because the two strings still differ, Claude's hook-dedup still fires and the TUI rename still paints.

Keep the `-n "ccairgap"` branch as a belt-and-suspenders fallback when `CCAIRGAP_NAME` is unset — the CLI always sets it now, but the entrypoint can still be launched directly by a user poking at the image.

#### Steps:

- [ ] **Step 1: Edit `docker/entrypoint.sh`**

Find (around line 127–138):

```bash
# Session name → `claude -n <name>` (seeds /resume label + terminal title).
# Intentionally differs from the UserPromptSubmit hook's sessionTitle output:
# the hook applies "[ccairgap]" / "[ccairgap] $CCAIRGAP_NAME" on first prompt,
# which renames the session and paints the TUI's TextInput border. If `-n` and
# the hook emitted the same string, Claude's hook dedup (Ma8) would skip the
# rename and the border recolor would never fire.
if [ -n "${CCAIRGAP_NAME:-}" ]; then
    NAME_ARGS=(-n "$CCAIRGAP_NAME")
else
    NAME_ARGS=(-n "ccairgap")
fi
```

Replace with:

```bash
# Session label → `claude -n "ccairgap <id>"` (seeds /resume label + terminal
# title). Intentionally differs from the UserPromptSubmit hook's sessionTitle
# output "[ccairgap] <id>": if the two strings matched, Claude's hook dedup
# would skip the rename and the TUI TextInput border would never recolor.
# CCAIRGAP_NAME carries the full session id from the CLI; the fallback branch
# only runs when the entrypoint is executed directly without the CLI env.
if [ -n "${CCAIRGAP_NAME:-}" ]; then
    NAME_ARGS=(-n "ccairgap $CCAIRGAP_NAME")
else
    NAME_ARGS=(-n "ccairgap")
fi
```

Also update the sessionTitle hook (around lines 91–98) — it already reads `CCAIRGAP_NAME` and emits `[ccairgap] $CCAIRGAP_NAME`. No change needed there. Verify the block currently reads:

```bash
TITLE_HOOK="/tmp/ccairgap-session-title.sh"
cat > "$TITLE_HOOK" << 'HOOK_EOF'
#!/bin/sh
TITLE="${CCAIRGAP_NAME:+[ccairgap] $CCAIRGAP_NAME}"
TITLE="${TITLE:-[ccairgap]}"
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"%s"}}\n' "$TITLE"
HOOK_EOF
chmod +x "$TITLE_HOOK"
```

Leave this untouched.

- [ ] **Step 2: Shellcheck**

Run: `shellcheck docker/entrypoint.sh`
Expected: no new warnings vs. pre-change (run once on current HEAD first to establish baseline if unsure).

- [ ] **Step 3: Commit**

```bash
git add docker/entrypoint.sh
git commit -m "refactor(entrypoint): use 'ccairgap <id>' as initial claude -n label

The two-step rename still works: '-n \"ccairgap <id>\"' initially,
then the UserPromptSubmit hook rewrites to '[ccairgap] <id>' on first
prompt. CCAIRGAP_NAME now carries the full session id from the CLI."
```

---

