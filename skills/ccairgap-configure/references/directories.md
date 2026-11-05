# Directories

Choose the least permissive surface that lets the workflow run. Move up the ladder only when the user asks for writes or the workflow cannot run otherwise.

| Level | Surface | Host written? | Result kept? | Use when |
|---|---|---|---|---|
| 0 | nothing | no | n/a | The path is git-tracked, so the session clone already has it. |
| 1 | `ro` | no | n/a | Default for large gitignored build and cache directories. Also for material outside the repo, such as a types package or a docs tree. |
| 2 | `extra-repo` | no | yes, on a sandbox branch | The user edits a second git repo alongside the workspace. |
| 3 | `cp` | no | no | A command writes into the directory, and the user does not need the result. |
| 4 | `sync` | no | yes, in `output/<id>/` | The user wants the result after the session, and the host original stays as it is. |
| 5 | `mount` | **yes, live** | yes, in place | The user accepts host writes for this path, usually because regeneration is expensive. |

Only `mount` writes to the host path, so it weakens the host-write guarantee for that path. Use `mount` instead of a raw `-v` flag, because `mount` is narrower and the CLI checks it for overlaps. Each host path can appear in only one of these keys, and a missing `cp`, `sync` or `mount` path fails the launch.

## The gitignore rule

`ccairgap` clones the workspace from git, so the session contains only tracked files. Gitignored directories are missing from the container. Without them, imports do not resolve, language servers fail and a search cannot reach dependency source.

For each directory of the project type, add it to `ro` if both checks pass:

```bash
for d in node_modules .next dist .turbo; do
  if [ -d "$REPO/$d" ] && git -C "$REPO" check-ignore "$d" >/dev/null 2>&1; then
    echo "ro: $d"
  fi
done
```

| Project type | Directories to check |
|---|---|
| Node, Bun, Deno | `node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `dist`, `build`, `out`, `.cache` |
| Python | `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.tox` |
| Rust | `target` |
| Go | `vendor` |
| JVM | `target`, `build`, `.gradle` |
| Ruby | `vendor/bundle` |
| iOS, Xcode | `Pods`, `DerivedData` |

A `ro` `.venv` gives read access to dependency source only, because its interpreter is a symlink to a host path. Leave it out when the workflow runs `uv` or `pip` in the session, so that the tool builds a new environment in the clone.

Skip a directory that regenerates in seconds and has nothing worth reading, such as `__pycache__`. The rule covers the workspace repo only. Ask the user about directories outside it.

## When the user asks for writes

A request such as "run `npm install`" or "run the tests" needs writes to a `ro` directory. Tell the user that, then walk this tree:

1. Should changes appear on the host path? If yes, use `mount`, and name the host-write trade-off in your reply.
2. Otherwise, should the result survive the session? If yes, use `sync`. If no, use `cp`.

## Examples

**Node project, reading only.** `npm install` and `npm run build` fail, and everything else works.

```yaml
ro:
  - node_modules
  - .next
  - dist
```

**Node project that also runs its tests.** The tests write to `node_modules/.cache`, so only that directory moves up the ladder.

```yaml
ro:
  - .next
  - dist
cp:
  - node_modules   # writes stay in the session
```

**Rust project, with a cache that the user asked to keep live.**

```yaml
mount:
  - target
```

**A shared types repo.** Use the first form to read it, and the second form to edit it on a sandbox branch.

```yaml
ro:
  - ../shared-types
```

```yaml
extra-repo:
  - ../shared-types
```

**Build output that the user wants after the session.** The copy lands at `$CCAIRGAP_HOME/output/<id>/<abs-repo>/dist/`.

```yaml
sync:
  - dist
```

## Limits

- `~/.claude/` has a built-in read-only mount. Do not use `mount` to persist its state.
- `repo` and `extra-repo` handle git repos with a clone and a sandbox branch. Do not add them to the ladder's other keys.
- `ccairgap recover <id>` runs the `sync` copy again, and the copy is idempotent. `cp` content ends with the session. `mount` writes have already reached the host.
