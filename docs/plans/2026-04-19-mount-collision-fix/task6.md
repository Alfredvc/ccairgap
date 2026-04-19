### Task 6: Thread `alternatesName` through session clone, policy scratch dir, and alternates mount

**Depends on:** Task 5
**Commit:** implementer
**Files:**
- Modify: `src/launch.ts` (RepoPlan, clone loop, writeAlternates call, pointLfsAtHost call, hooks/mcp inputs)
- Modify: `src/hooks.ts` (policy scratch dir uses `alternatesName` in place of `basename`)
- Modify: `src/mcp.ts` (same)

#### Steps

- [ ] **Step 1: Extend `RepoPlan` and populate `alternatesName`**

Edit `src/launch.ts`:

Add to imports near the top:
```typescript
import { alternatesName } from "./alternatesName.js";
```

Update the `RepoPlan` type (around lines 163-169):
```typescript
  type RepoPlan = {
    basename: string;
    hostPath: string;
    realGitDir: string;
    sessionClonePath: string;
    alternatesName: string;
    baseRef?: string;
  };
```

Update `repoPlans.push` (around lines 179-187):
```typescript
    const bn = basename(hostPath);
    const altName = alternatesName(bn, hostPath);
    repoPlans.push({
      basename: bn,
      hostPath,
      realGitDir,
      // Use altName in the clone path too so two repos sharing a basename
      // do not overwrite each other's clone under $SESSION/repos/.
      sessionClonePath: join(sessionPath, "repos", altName),
      alternatesName: altName,
      baseRef: opts.base,
    });
```

- [ ] **Step 2: Update clone-loop alternates path**

Edit `src/launch.ts` — in the clone loop (around lines 260-267):

```typescript
      writeAlternates(clonePath, `/host-git-alternates/${plan.alternatesName}/objects`);

      if (existsSync(join(plan.realGitDir, "lfs", "objects"))) {
        pointLfsAtHost(clonePath, `/host-git-alternates/${plan.alternatesName}/lfs/objects`);
      }
```

- [ ] **Step 3: Add `alternatesName` to hook/MCP policy inputs**

Edit `src/hooks.ts` and `src/mcp.ts`:

In `src/hooks.ts`, find the exported `HookPolicyRepo` interface (around line 32) and add the field:

```typescript
export interface HookPolicyRepo {
  basename: string;
  sessionClonePath: string;
  hostPath: string;
  /** Unique per-repo segment for policy scratch dirs. Produced by `alternatesName()`. */
  alternatesName: string;
}
```

In `src/mcp.ts`, do the same to the exported `McpPolicyRepo` interface (around line 286).

`enumerateHooks` / `enumerateMcpServers` accept a DIFFERENT, lighter `{basename, hostPath}[]` shape that is NOT touched by this plan — no scratch dirs are produced during enumeration, so the basename-collision bug does not exist there.

Replace `r.basename` with `r.alternatesName` **only in scratch-path constructions** (the `policyDir/projects/…` join at hooks.ts:498 and mcp.ts:498). Leave `r.basename` for user-facing diagnostics (e.g. the `hook-override` description label from Task 1 can continue to use `r.basename` — it's the human-readable repo name, not a path segment).

Example for `src/hooks.ts` line 498:
```typescript
const outPath = join(policyDir, "projects", r.alternatesName, fname);
```

Example for `src/mcp.ts` line 498:
```typescript
const outPath = join(policyDir, "projects", r.alternatesName, ".mcp.json");
```

- [ ] **Step 4: Pass `alternatesName` into hook/MCP calls in `launch.ts`**

Edit `src/launch.ts` — the `applyHookPolicy` call (around lines 338-342) and `applyMcpPolicy` call (around lines 360-364) both build a repos map. Extend:

```typescript
    repos: repoEntries.map((r) => ({
      basename: r.basename,
      sessionClonePath: r.sessionClonePath,
      hostPath: r.hostPath,
      alternatesName: r.alternatesName,
    })),
```

- [ ] **Step 5: Pass `alternatesName` into `buildMounts`**

Edit `src/launch.ts` — the `buildMounts` call (around line 376). The `repos: repoEntries` entry already has `alternatesName` from the extended `RepoPlan`. Verify the type compiles.

- [ ] **Step 6: Add `alternates_name` to `ManifestV1`**

Edit `src/manifest.ts` — extend the `repos` entry shape (lines 11-15):

```typescript
  repos: Array<{
    basename: string;
    host_path: string;
    base_ref?: string;
    /**
     * Unique per-repo scratch segment (`<basename>-<sha256(host_path)[:8]>`).
     * Additive v1 field: sessions written by older CLI builds omit this and
     * handoff/orphans fall back to `basename`. Kept optional so pre-existing
     * sessions on disk recover without a version bump.
     */
    alternates_name?: string;
  }>;
```

Do NOT bump `MANIFEST_VERSION`. Additive optional fields are explicitly supported v1 back-compat precedent (see `branch?` / `sync?` — lines 16-29).

- [ ] **Step 7: Populate `alternates_name` in manifest build**

Edit `src/launch.ts` — the manifest build (around lines 308-312):

```typescript
    repos: repoEntries.map((r) => ({
      basename: r.basename,
      host_path: r.hostPath,
      base_ref: r.baseRef,
      alternates_name: r.alternatesName,
    })),
```

- [ ] **Step 8: Update `handoff.ts` and `orphans.ts` to use the new segment with fallback**

Edit `src/handoff.ts` — line 150:

```typescript
    const sessionClone = join(sessionDirPath, "repos", repo.alternates_name ?? repo.basename);
```

Edit `src/orphans.ts` — line 47:

```typescript
        const sessionClone = join(sd, "repos", r.alternates_name ?? r.basename);
```

The `?? r.basename` fallback handles two cases: (a) manifests written by older CLI builds where the field is absent, (b) future sessions where alternatesName equals basename (won't happen with the sha256 suffix, but the fallback costs nothing).

- [ ] **Step 9: Typecheck and run tests**

Run: `cd /Users/alfredvc/src/ccairgap && npm run typecheck && npm test`

Expected: passes. Existing hook/MCP tests pass a fixture `repos` that now requires `alternatesName`. Update those fixtures:

- `src/hooks.test.ts` — search for `repos: [` and `sessionClonePath:` patterns; add `alternatesName: "..."`. Any deterministic string works; for readability use `` alternatesName: `${basename}-aaaaaaaa` `` or call `alternatesName(basename, hostPath)` from the real helper.
- `src/mcp.test.ts` — same change.

Also audit any existing assertion that pins a scratch-path string with `<basename>` in it:

```bash
cd /Users/alfredvc/src/ccairgap
Grep -n "policyDir|policy.*projects|policy.*plugins" src/*.test.ts
```

Every match that asserts on `projects/<basename>/...` must flip to `projects/${alternatesName}/...`.

- [ ] **Step 10: Commit**

```bash
git add src/launch.ts src/hooks.ts src/mcp.ts src/hooks.test.ts src/mcp.test.ts src/manifest.ts src/handoff.ts src/orphans.ts
git commit -m "fix(mounts): disambiguate per-repo scratch paths with alternatesName (clone dir + alternates mount + policy dir + manifest + handoff/orphans)"
```

---

