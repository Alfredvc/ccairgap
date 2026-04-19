# Directories: `--ro` vs `--cp` vs `--sync` vs `--mount`

This skill's default stance on host directories: the least permissive surface that lets the workflow function. For gitignored build/cache dirs the floor is `--ro` (read access without host writes); escalate only when the user asks for writes.

| Level | Surface | Host written? | Result preserved? | Default? |
|-------|---------|---------------|-------------------|----------|
| 0 | nothing | no | n/a | yes, for non-gitignored paths (already in the session clone) |
| 1 | `ro` | no | n/a | **yes, for gitignored large build/cache dirs that exist on host** — and for reference material outside the repo |
| 2 | `extra-repo` | no (sandbox branch) | yes, via fetch | when the user is editing a sibling repo alongside |
| 3 | `cp` | no | no (discarded) | opt-in (user wants writes but not preservation) |
| 4 | `sync` | no | yes, in `output/<id>/` | opt-in (user wants writes + result preserved) |
| 5 | `mount` | **yes, live** | yes (in place) | opt-in, with explicit user consent (writes land on host) |

## The gitignore rule

`ccairgap` clones the workspace from git. Gitignored dirs (`node_modules`, `target/`, `.venv`, `dist/`, `.next/`) are **not in the session clone** — the container sees an empty / missing path. Without a mount, imports don't resolve, LSP can't find type info, and grep over deps is impossible.

For each known large build/cache dir:

1. Run `git check-ignore <path>` — is it ignored?
2. Does the path exist on the host?

If both yes, the default is `ro:`. Claude gets read access to the host cache, writes are refused. If the user later asks Claude to run something that writes into that dir (install, build, test), escalate per the decision tree below.

### Known dirs by project type

| Project type | Dirs to check |
|---|---|
| Node / Bun / Deno | `node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `dist`, `build`, `out`, `.cache` |
| Python | `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.tox` |
| Rust | `target` |
| Go | `vendor` (only if gitignored) |
| JVM | `target`, `build`, `.gradle` |
| Ruby | `vendor/bundle` |
| iOS / Xcode | `Pods`, `DerivedData` |

Rules:

- Only include if `git check-ignore` says yes. Repos that commit `node_modules` or `vendor/` don't need the mount.
- Only include if the dir exists on the host. Don't speculatively add `target` to a Node project.
- Tiny ignored caches (`__pycache__/`, per-file caches) aren't worth an entry. The bar: would Claude benefit from reading the contents, and would regenerating them take more than a few seconds of useful work?
- All of this is *inside* the workspace repo. Dirs outside it need the user to tell you what to expose (and usually those are source / reference dirs → `ro:` or `extra-repo:`, not artifact dirs).

## Decision tree for escalation requests

When a user asks for writes to a `ro:` dir — "run `npm install`", "run the test suite", "recompile" — walk this:

1. **Do they want container changes reflected on the host original path?**
   - Yes → `mount`. Fastest. Writes host live. Weakens the "host FS is immutable" invariant for that one path — name the tradeoff in your response.
   - No → keep going.
2. **Do they want to keep the result anywhere?**
   - No → `cp`. Session gets a full mutable copy at launch; discarded on exit. Host original untouched.
   - Yes → `sync`. Result lands in `$CCAIRGAP_HOME/output/<id>/<abs-src>/`. Host original untouched.

All of `cp` / `sync` / `mount` resolve relative paths against the **workspace repo root** (not the config file dir). All fail if the host path doesn't exist at launch. A given host path can appear in only one of `--repo` / `--extra-repo` / `--ro` / `--cp` / `--sync` / `--mount`.

## Worked examples

### "Node project — standard setup"

Host has `node_modules`, `.next`, `dist`. All gitignored.

```yaml
ro:
  - node_modules
  - .next
  - dist
```

Claude can read deps, inspect build output, run typechecks that don't write. `npm install` / `npm run build` will fail; if the user needs those, escalate per the tree.

### "Node project — I also need to run the test suite"

Tests write to `node_modules/.cache/` and create snapshot files. Escalate `node_modules` only.

```yaml
ro:
  - .next
  - dist
cp:
  - node_modules          # writes land in session scratch, discarded on exit
```

If the user wants the test snapshot updates preserved instead, `sync: [node_modules]`. If they want the cache to persist across sessions, `mount: [node_modules]` (host writes).

### "Rust project — just reading code"

```yaml
ro:
  - target
```

Compilation won't work, but `cargo check` against already-compiled artifacts and reading dep source works.

### "Rust project — recompiles are expensive, I want the cache live"

User explicitly asked:

```yaml
mount:
  - target
```

### "Claude needs to read our shared types repo"

```yaml
ro:
  - ../shared-types
```

### "Claude needs to edit the shared types repo alongside my workspace"

```yaml
extra-repo:
  - ../shared-types
```

### "I want the build output after the session"

User asked for preservation:

```yaml
sync:
  - dist
```

On exit, `dist/` copy lands at `$CCAIRGAP_HOME/output/<id>/<abs-repo>/dist/`. Host original untouched.

## Absolute vs relative paths

- Relative paths (preferred in committed config): resolved against workspace repo root.
- Absolute paths: allowed but warn if outside every declared repo tree.

```yaml
ro:
  - node_modules              # → <repo>/node_modules
  - /opt/reference-data       # absolute (warning if outside repo)
```

## Things that are NOT artifact decisions

- **`~/.claude/`** — always RO, via the built-in mount. Don't try to use `mount` to persist its state.
- **The repo itself** — that's `repo` / `extra-repo` (they do their own clone-+-sandbox-branch thing).
- **Secrets / API keys** — don't mount credential files. See `references/secrets-and-sensitive-data.md`.

## Recovery implication

`sync` paths are recorded in the session manifest. If the session is orphaned and recovered via `ccairgap recover <id>`, the sync copy-out runs again — safe and idempotent. `cp` is session-local; discarded if the session is discarded. `mount` has no recovery semantics since writes already landed during the session.
