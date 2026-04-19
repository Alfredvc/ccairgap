### Task 11: Update project documentation

**Depends on:** Tasks 4, 6, 9
**Commit:** implementer
**Files:**
- Modify: `docs/SPEC.md`
- Modify: `CLAUDE.md`

#### Steps

- [ ] **Step 1: Update SPEC §"Container mount manifest"**

Edit `docs/SPEC.md`. Replace the two alternates rows (currently referencing `<basename>`):

```
| `<resolved-git-dir>/objects/` | `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/objects/` | ro | Alternates target for `--shared` clone. The `<sha256>` suffix disambiguates multi-repo sessions where two `--repo`/`--extra-repo` paths share a basename. The session clone's `.git/objects/info/alternates` is rewritten to this container path so new commits write to the session clone's own RW `objects/` while historical reads resolve through here. See §"Repository access mechanism". |
| `<resolved-git-dir>/lfs/objects/` | `/host-git-alternates/<basename>-<sha256(hostPath)[:8]>/lfs/objects/` | ro | LFS content. Session clone's `.git/lfs/objects/` is replaced with a symlink to this path. Mount is optional — skipped if source dir doesn't exist. |
```

Right after the §"Container mount manifest" table, insert a new subsection:

```markdown
### Mount-collision policy

Before invoking `docker run`, ccairgap resolves mount conflicts in two passes:

1. **Marketplace pre-filter (`filterSubsumedMarketplaces`).** If a plugin marketplace path from `extraKnownMarketplaces` equals or is nested inside any `--repo`/`--extra-repo` `hostPath`, the marketplace mount is dropped. The repo's session-clone RW mount serves those files at the same container path. A stderr warning notes the drop and reminds users that the container sees HEAD-only content (uncommitted files in the marketplace tree are not visible).
2. **Collision resolver (`resolveMountCollisions`).** Defense-in-depth at the end of `buildMounts`:
   - Any two surviving mounts sharing a container `dst` throw with both source labels (`--repo/--extra-repo`, `--ro`, `--mount`, `plugin marketplace`, etc.).
   - User-source mounts may not use reserved container paths: `/output`, `/host-claude`, `/host-claude-json`, `/host-claude-creds`, `/host-claude-patched-settings.json`, `/host-claude-patched-json`, `<home>/.claude/projects`, `<home>/.claude/plugins/cache`, anything under `/host-git-alternates/`.

Nested mounts with distinct `dst` strings (hook/MCP single-file overlays on top of a repo, `--mount` paths inside a repo) are **allowed** — they're the intended overlay mechanism.

Symlinks in `--repo`/`--extra-repo`/`--ro` paths are resolved via `realpath()` before the overlap check, so `--repo /sym --ro /real` (where `/sym → /real`) is correctly caught.
```

- [ ] **Step 2: Update SPEC §"Repository access mechanism"**

Find the three `<basename>` references in this section (around lines 458-462) and replace with `<basename>-<sha256(hostPath)[:8]>`. Add a sentence right after step 2:

```
The `<sha256(hostPath)[:8]>` suffix disambiguates multi-repo sessions where two `--repo`/`--extra-repo` paths share a basename (e.g. `/a/myrepo` and `/b/myrepo` both named `myrepo`). Without this suffix, both would mount at `/host-git-alternates/myrepo/objects`, which Docker rejects as a duplicate mount point.
```

Also update the `$SESSION/repos/<basename>/` row in §"Container mount manifest" to `$SESSION/repos/<basename>-<sha256(hostPath)[:8]>/` (same disambiguation).

- [ ] **Step 2b: Update SPEC §"Manifest" (or the nearest equivalent section) with `alternates_name`**

Find the section of `docs/SPEC.md` that documents the manifest shape (search for `manifest.json`, `version: 1`, or the repos array schema). Add an entry for the new field:

```
- `repos[].alternates_name` (string, optional, additive v1): unique per-repo scratch segment `<basename>-<sha256(host_path)[:8]>`. Handoff/recover/orphan-scan use this to locate `$SESSION/repos/<alternates_name>` on disk. Omitted in sessions written by older CLI builds; consumers MUST fall back to `basename` when absent.
```

If SPEC doesn't yet have a dedicated manifest section, add a short paragraph inside §"Session state & recovery" (near the `recover` subcommand description).

- [ ] **Step 3: Update SPEC §"Plugin marketplace discovery"**

Edit `docs/SPEC.md` lines 635-654. Replace the paragraph about bind-mounting each path with:

```markdown
- The CLI extracts absolute paths from `extraKnownMarketplaces` entries in host `~/.claude/settings.json` whose `source.source` is `"directory"` or `"file"`. These reference plugin marketplaces living outside `~/.claude/` (e.g. `~/src/agentfiles`, `~/src/claude-meta`).
- `github`/`git`/`npm`/`url` marketplaces resolve via the RO-mounted `~/.claude/plugins/cache/` — no extra mount needed.
- Each extracted path is RO bind-mounted at its original absolute path so `settings.json` references resolve inside the container — UNLESS the path equals or is nested inside a `--repo`/`--extra-repo` tree, in which case the mount is dropped (the repo's session clone already serves those files at the same container path). A stderr warning names the affected marketplace.
```

- [ ] **Step 4: Update CLAUDE.md invariants**

Edit `CLAUDE.md` — in the "Non-obvious invariants" list (after the `--cap-drop=ALL` invariant at the end), add:

```markdown
- **Mount list is deduped before `docker run`.** `buildMounts` ends with a `resolveMountCollisions` pass that errors on any exact `dst` collision and on any user-sourced mount using a reserved container path (`/output`, `/host-claude*`, `<home>/.claude/projects|plugins/cache`, under `/host-git-alternates/`). The earlier `filterSubsumedMarketplaces` pre-filter drops plugin marketplaces that the workspace repo already covers — kept separate so resolveArtifacts's overlap check never sees the marketplace==repo case.
- **Per-repo scratch paths use `alternatesName = <basename>-<sha256(hostPath)[:8]>`**, not bare `<basename>`. Required for multi-repo sessions with same-basename paths. Applies to `$SESSION/repos/`, `/host-git-alternates/`, and `$SESSION/policy/…/projects/`. Keep `launch.ts` (RepoPlan construction), `mounts.ts` (alternates mount), and `hooks.ts`/`mcp.ts` (policy scratch dir) in sync via the shared `alternatesName` field.
- **Symlinks in `--repo`/`--extra-repo`/`--ro` resolve via `realpath()` before the overlap check** (`validateRepoRoOverlap` in `launch.ts`). `resolve()` is insufficient — it does not follow symlinks, which was how two instances of the same real repo (one symlinked, one direct) used to bypass the duplicate guard.
```

- [ ] **Step 5: Commit**

```bash
git add docs/SPEC.md CLAUDE.md
git commit -m "docs: mount-collision policy, alternatesName disambiguation, symlink overlap guard"
```

---

