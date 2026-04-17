# Build-artifact dirs: `--cp` vs `--sync` vs `--mount`

Build artifacts are dirs not tracked in git that matter at runtime (`node_modules`, `.venv`, `target/`, `dist/`, `.next/`, `.cache/`). Three CLI options cover the common shapes; they differ in two axes: **is the original host path written** and **is the result available after the session**.

## The three options at a glance

| Option | Pre-launch | Container sees | On exit | Host original written? | Result preserved? |
|--------|-----------|----------------|---------|------------------------|-------------------|
| `--cp <path>` | `rsync -a --delete` host → session | RW at original abs path | session dir `rm -rf`'d | no | no (thrown away) |
| `--sync <path>` | same as `--cp` | RW at original abs path | rsync session → `output/<ts>/<abs-src>/` | no | yes, in `output/<ts>/` |
| `--mount <path>` | nothing | RW at original abs path (live bind) | nothing | **yes, live** | yes, in host original |

All three resolve relative paths against the **workspace repo root** (not the config file dir). All three fail if the host path doesn't exist at launch. A given host path can only appear in one of `--repo` / `--extra-repo` / `--ro` / `--cp` / `--sync` / `--mount`.

## Decision tree

Ask, in order:

1. **Does the user want the container's modifications to land back on the host original path?**
   - Yes → `--mount`. Fastest. Writes host live. Weakens the "host FS can't be mutated" invariant for this path, explicitly.
   - No → keep going.
2. **Does the user want to keep the result anywhere?**
   - No → `--cp`. Results evaporate.
   - Yes → `--sync`. Result lands in `$CLAUDE_AIRGAP_HOME/output/<ts>/<abs-src>/`. Original host path untouched. User cherry-picks from there.

## Practical recommendations by dir

| Dir | Typical answer | Why |
|-----|----------------|-----|
| `node_modules` | `--mount` | Installing is slow, low-risk rewrite, live cache hits matter. |
| `.venv` / `venv` | `--mount` | Same. |
| `__pycache__`, `.mypy_cache`, `.ruff_cache` | `--mount` or omit | Cheap to recreate; often not worth configuring. |
| `target/` (Rust) | `--mount` | Compilation is expensive; cache is worth a lot. |
| `.gradle/`, `.m2/` | `--mount` | Same. |
| `dist/`, `build/`, `.next/`, `.nuxt/` | `--sync` | Build outputs the user wants after the session, but shouldn't clobber pre-existing. |
| Generated reports (Playwright, jest coverage) | `--sync` | User wants to look at them after. |
| Scratch `/tmp`-like dirs the agent might write | `--cp` or nothing | Discardable. |
| Random host config dirs (`~/.config/*`, `~/.ssh`, etc.) | **none of the above** | Don't mount secrets. Pass via env if needed. |

## Worked examples

### "Node project, I want `node_modules` to persist, and I want the build output after"

```yaml
mount:
  - node_modules
sync:
  - dist
```

Container gets live `node_modules` at the original path; on exit, `dist/` copy is dropped at `$CLAUDE_AIRGAP_HOME/output/<ts>/<abs-repo>/dist/`. Original `dist/` on host is untouched.

### "I want to try a build from a clean-but-seeded `node_modules`, throw away result"

```yaml
cp:
  - node_modules
```

Session clone gets a fresh copy at launch; container modifies freely; session dir is deleted on exit. Host `node_modules` unchanged regardless.

### "Shared Rust workspace, compile cache is 20 GB"

```yaml
mount:
  - target
```

Container builds into host `target/` directly. Fast. User explicitly opts into live host writes for this path.

### "Python project, Playwright generates a report I want to keep"

```yaml
mount:
  - .venv
sync:
  - playwright-report
  - test-results
```

`.venv` persists across sessions; reports land in `output/<ts>/`.

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

- **`~/.claude/`** — always RO, via the built-in mount. Don't try to use `--mount` to persist its state.
- **The repo itself** — that's `--repo` / `--extra-repo` (they do their own clone-+-sandbox-branch thing).
- **Read-only reference material** — that's `--ro`.
- **Secrets / API keys** — don't mount files; use env (`docker-run-arg: ["-e NAME"]`).

## Recovery implication

`--sync` paths are recorded in the session manifest. If the session is orphaned and recovered via `ccairgap recover <ts>`, the sync copy-out runs again — safe and idempotent. `--cp` is session-local; discarded if the session is discarded. `--mount` has no recovery semantics since writes already landed during the session.
