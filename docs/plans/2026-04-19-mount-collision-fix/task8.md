### Task 8: Include marketplaces in `resolveArtifacts` overlap check

**Depends on:** Tasks 1, 2
**Commit:** implementer
**Files:**
- Modify: `src/artifacts.ts`
- Modify: `src/artifacts.test.ts`
- Modify: `src/launch.ts`

#### Steps

- [ ] **Step 1: Write failing tests in `artifacts.test.ts`**

Inside the main `describe("resolveArtifacts", () => { ... })` block, add:

```typescript
  it("errors when --mount path overlaps a plugin marketplace", () => {
    const mkt = join(root, "mkt");
    mkdirSync(mkt, { recursive: true });
    expect(() =>
      resolveArtifacts({
        cp: [],
        sync: [],
        mount: [mkt],
        repos,
        roPaths: [],
        marketplaces: [mkt],
        sessionDir,
      }),
    ).toThrow(/used by both.*marketplace.*--mount/);
  });

  it("errors when --ro path overlaps a plugin marketplace", () => {
    const mkt = join(root, "mkt2");
    mkdirSync(mkt, { recursive: true });
    expect(() =>
      resolveArtifacts({
        cp: [],
        sync: [],
        mount: [],
        repos,
        roPaths: [mkt],
        marketplaces: [mkt],
        sessionDir,
      }),
    ).toThrow(/used by both.*marketplace.*--ro/);
  });

  it("accepts pre-filtered marketplaces that don't overlap with anything", () => {
    const mkt = join(root, "mkt3");
    mkdirSync(mkt, { recursive: true });
    const r = resolveArtifacts({
      cp: [],
      sync: [],
      mount: [],
      repos,
      roPaths: [],
      marketplaces: [mkt],
      sessionDir,
    });
    expect(r.entries).toEqual([]);
    expect(r.extraMounts).toEqual([]);
  });
```

Run: `cd /Users/alfredvc/src/ccairgap && npx vitest run src/artifacts.test.ts`

Expected: new tests fail because `marketplaces` is not recognized.

- [ ] **Step 2: Extend `ResolveArtifactsInput` and the `mark` loop**

Edit `src/artifacts.ts`:

Extend `ResolveArtifactsInput` (around line 33-46):
```typescript
export interface ResolveArtifactsInput {
  cp: string[];
  sync: string[];
  mount: string[];
  repos: RepoForArtifacts[];
  /** Resolved --ro paths; used for overlap detection. */
  roPaths: string[];
  /**
   * Plugin marketplace host paths AFTER the subsumed-by-repo pre-filter.
   * Callers must run `filterSubsumedMarketplaces` first — this function errors
   * unconditionally on any overlap, including the marketplace-equals-repo case.
   */
  marketplaces: string[];
  sessionDir: string;
  relativeAnchor?: string;
}
```

Extend the `mark` loop (around lines 145-147):
```typescript
  for (const r of i.repos) mark(r.hostPath, `--repo/--extra-repo ${r.hostPath}`);
  for (const p of i.roPaths) mark(p, `--ro ${p}`);
  for (const p of i.marketplaces) mark(p, `plugin marketplace ${p}`);
  for (const e of entries) mark(e.srcHost, `--${e.kind} ${e.raw}`);
```

- [ ] **Step 3: Update existing call sites in the test file**

Every existing `resolveArtifacts({ ... })` call must add `marketplaces: []`. Edit `src/artifacts.test.ts` — in each call site, add the line `marketplaces: [],` directly after `roPaths:`. There are ~12 such call sites; use an editor to catch them all.

- [ ] **Step 4: Update the launch caller**

Edit `src/launch.ts` — the `resolveArtifacts` call (around lines 211-223) must pass the pre-filtered marketplace list. This requires discovering marketplaces and filtering them BEFORE `resolveArtifacts` runs.

Move marketplace discovery above the `resolveArtifacts` call and add the filter. The current code (lines 229-230) has:

```typescript
  const hostClaude = realpath(hostClaudeDir(env));
  const marketplaces = discoverLocalMarketplaces(hostClaude, home);
```

Move these two lines to just before the `resolveArtifacts` call (around line 207), and add the pre-filter. Then delete them from their original position.

```typescript
  // Step: discover and pre-filter plugin marketplaces.
  // Filtering subsumed-by-repo marketplaces BEFORE resolveArtifacts is
  // critical — resolveArtifacts's overlap check would otherwise fatal on the
  // marketplace-equals-workspace-repo case instead of letting it pass through
  // as a warn-and-drop.
  const hostClaude = realpath(hostClaudeDir(env));
  const rawMarketplaces = discoverLocalMarketplaces(hostClaude, home);
  const marketplaceFilter = filterSubsumedMarketplaces(
    rawMarketplaces,
    repoPlans.map((r) => r.hostPath),
  );
  for (const w of marketplaceFilter.warnings) console.error(`ccairgap: ${w}`);
  const marketplaces = marketplaceFilter.marketplaces;

  // Resolve cp/sync/mount: validate, detect overlaps, plan copies & mounts.
  let artifacts;
  try {
    artifacts = resolveArtifacts({
      cp: opts.cp,
      sync: opts.sync,
      mount: opts.mount,
      repos: repoPlans.map((r) => ({
        basename: r.basename,
        hostPath: r.hostPath,
        sessionClonePath: r.sessionClonePath,
      })),
      roPaths: roResolved,
      marketplaces,
      sessionDir: sessionPath,
      relativeAnchor: opts.bare ? process.cwd() : undefined,
    });
  } catch (e) {
    die((e as Error).message);
  }
  for (const w of artifacts.warnings) console.error(`ccairgap: ${w}`);
```

Add the import at the top:
```typescript
import { filterSubsumedMarketplaces } from "./marketplaces.js";
```

Delete the old `const hostClaude = realpath(...)` and `const marketplaces = discoverLocalMarketplaces(...)` lines from their original position (around lines 229-230).

- [ ] **Step 5: Run tests**

Run: `cd /Users/alfredvc/src/ccairgap && npm test`

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/artifacts.ts src/artifacts.test.ts src/launch.ts
git commit -m "fix(artifacts): include pre-filtered marketplaces in overlap check; wire pre-filter into launch"
```

---

