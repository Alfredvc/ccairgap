# Directories: `--ro` vs `--cp` vs `--sync` vs `--mount`

This skill's default stance on host directories is **conservative**: add the least permissive surface that works, and escalate only when the user asks. The full ladder:

| Level | Surface | Host written? | Result preserved? | Default? |
|-------|---------|---------------|-------------------|----------|
| 0 | nothing | no | n/a | yes, for artifact dirs inside the workspace repo |
| 1 | `ro` | no | n/a | yes, for reference material outside the workspace repo |
| 2 | `extra-repo` | no (sandbox branch) | yes, via fetch | when the user is editing a sibling repo alongside |
| 3 | `cp` | no | no (discarded) | opt-in |
| 4 | `sync` | no | yes, in `output/<ts>/` | opt-in |
| 5 | `mount` | **yes, live** | yes (in place) | opt-in, with explicit user consent |

The key mental model: the workspace repo is already cloned into a session scratch dir at launch — artifacts inside it (`node_modules`, `dist`, `target`) will be regenerated from scratch on first use. That's fine by default. Escalation only happens when the user tells you regeneration is unacceptable, or the workflow literally cannot produce what they need without preservation.

## Starting point by directory type

| Dir | Default | Promote when user says… |
|-----|---------|-------------------------|
| The workspace repo itself | built-in `--repo` mount (nothing to configure) | — |
| Another git repo they're editing alongside | — | "I need to also edit `../sibling-repo`" → `extra-repo` |
| Docs tree, shared types package, reference dataset | — | "Claude needs to read `../shared-types`" → `ro` |
| `node_modules`, `.venv`, `.gradle`, `.m2` | nothing (container regenerates) | "reinstalling `node_modules` every session is too slow" → `mount` (user consents) or `cp` (no preservation) |
| `target/` (Rust), build caches | nothing | "compile cache matters, rebuilds are minutes" → `mount` (user consents) |
| `dist/`, `build/`, `.next/` | nothing | "I want the build output after the session" → `sync` |
| Generated reports (Playwright, coverage) | nothing | "I want to look at the report afterwards" → `sync` |
| Scratch dirs the agent might write | nothing | rarely worth configuring |
| Host config dirs (`~/.config/*`, `~/.ssh`, `~/.aws`) | **never auto-mount** | see `secrets-and-sensitive-data.md` |

"The directory is big" is not an escalation trigger. "The user has told me regenerating it hurts their workflow" is.

## Decision tree for escalation requests

When a user does ask to preserve a directory, walk this:

1. **Do they want container changes reflected on the host original path?**
   - Yes → `mount`. Fastest. Writes host live. Weakens the "host FS is immutable" invariant for that one path — name the tradeoff in your response.
   - No → keep going.
2. **Do they want to keep the result anywhere?**
   - No → `cp`. Session gets a copy at launch; discarded on exit. Host original untouched regardless.
   - Yes → `sync`. Result lands in `$CLAUDE_AIRGAP_HOME/output/<ts>/<abs-src>/`. Host original untouched.

All three of `cp` / `sync` / `mount` resolve relative paths against the **workspace repo root** (not the config file dir). All three fail if the host path doesn't exist at launch. A given host path can appear in only one of `--repo` / `--extra-repo` / `--ro` / `--cp` / `--sync` / `--mount`.

## Worked examples

### "Claude needs to read our shared types repo"

```yaml
ro:
  - ../shared-types
```

Read-only sibling. No escalation needed.

### "Claude needs to edit the shared types repo alongside my workspace"

```yaml
extra-repo:
  - ../shared-types
```

Gets its own sandbox branch; fetch-on-exit mirrors the workspace flow. Host original repo untouched; you recover changes the same way as `--repo`.

### "Reinstalling node_modules every time is too slow" (user asked)

```yaml
mount:
  - node_modules
```

Live bind. Regeneration cost paid once. Explicit opt-in to host writes for this one path.

### "I want to try a build from a fresh node_modules, throw away result" (user asked)

```yaml
cp:
  - node_modules
```

Session clone gets a fresh copy at launch; container modifies freely; session dir deleted on exit. Host `node_modules` unchanged.

### "I want the build output after the session" (user asked)

```yaml
sync:
  - dist
```

On exit, `dist/` copy lands at `$CLAUDE_AIRGAP_HOME/output/<ts>/<abs-repo>/dist/`. Host original untouched.

### "Python project with Playwright, I want the report" (user asked for .venv cache + report)

```yaml
mount:
  - .venv
sync:
  - playwright-report
  - test-results
```

`.venv` persists across sessions (user consented to the live write). Reports land in `output/<ts>/`.

## Absolute vs relative paths

- Relative paths (preferred in committed config): resolved against workspace repo root.
- Absolute paths: allowed but warn if outside every declared repo tree.

Examples:

```yaml
cp:
  - node_modules              # → <repo>/node_modules
  - /var/cache/npm            # absolute, outside repo (warning)
```

## Things that are NOT artifact decisions

- **`~/.claude/`** — always RO, via the built-in mount. Don't try to use `mount` to persist its state.
- **The repo itself** — that's `repo` / `extra-repo` (they do their own clone-+-sandbox-branch thing).
- **Secrets / API keys** — don't mount credential files. See `references/secrets-and-sensitive-data.md`.

## Recovery implication

`sync` paths are recorded in the session manifest. If the session is orphaned and recovered via `ccairgap recover <ts>`, the sync copy-out runs again — safe and idempotent. `cp` is session-local; discarded if the session is discarded. `mount` has no recovery semantics since writes already landed during the session.
