### Task 2: Implement marketplace pre-filter (subsumed-by-repo drop)

**Depends on:** Task 1
**Parallel with:** Task 3 (collision-resolver tests/impl), Task 4 (alternatesName)
**Commit:** implementer
**Files:**
- Create: `src/marketplaces.ts`
- Create: `src/marketplaces.test.ts`

#### Steps

- [ ] **Step 1: Write failing tests**

Create `src/marketplaces.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { filterSubsumedMarketplaces } from "./marketplaces.js";

describe("filterSubsumedMarketplaces", () => {
  it("passes marketplaces through when no repos subsume them", () => {
    const r = filterSubsumedMarketplaces(["/mkt/a", "/mkt/b"], ["/repos/x"]);
    expect(r.marketplaces).toEqual(["/mkt/a", "/mkt/b"]);
    expect(r.warnings).toEqual([]);
  });

  it("drops marketplace whose path equals a repo hostPath exactly", () => {
    const r = filterSubsumedMarketplaces(["/work/agentfiles"], ["/work/agentfiles"]);
    expect(r.marketplaces).toEqual([]);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toContain("/work/agentfiles");
    expect(r.warnings[0]).toContain("marketplace");
    expect(r.warnings[0]).toContain("committed");
  });

  it("drops marketplace nested inside a repo tree", () => {
    const r = filterSubsumedMarketplaces(
      ["/work/mono/plugins/market"],
      ["/work/mono"],
    );
    expect(r.marketplaces).toEqual([]);
    expect(r.warnings[0]).toContain("/work/mono/plugins/market");
    expect(r.warnings[0]).toContain("/work/mono");
  });

  it("keeps marketplaces that are siblings of repos (not subsumed)", () => {
    const r = filterSubsumedMarketplaces(["/work/marketplaces"], ["/work/repo"]);
    expect(r.marketplaces).toEqual(["/work/marketplaces"]);
    expect(r.warnings).toEqual([]);
  });

  it("does not treat prefix-similar paths as subsumed (path boundary check)", () => {
    const r = filterSubsumedMarketplaces(["/work/repo-plugins"], ["/work/repo"]);
    expect(r.marketplaces).toEqual(["/work/repo-plugins"]);
    expect(r.warnings).toEqual([]);
  });

  it("mentions session-clone HEAD semantics in the warning", () => {
    const r = filterSubsumedMarketplaces(["/work/r"], ["/work/r"]);
    expect(r.warnings[0]).toMatch(/session clone|HEAD|committed/);
  });
});
```

Run: `cd /Users/alfredvc/src/ccairgap && npx vitest run src/marketplaces.test.ts`

Expected: all 6 tests fail — module does not exist.

- [ ] **Step 2: Implement the pre-filter**

Create `src/marketplaces.ts`:

```typescript
/**
 * Plugin marketplaces discovered via `extraKnownMarketplaces` in the host
 * settings.json are mounted RO at their host paths. When a marketplace path
 * equals or lives inside a `--repo`/`--extra-repo` tree, the repo's session
 * clone already serves those files via its own RW mount at the same path —
 * keeping both mounts would trigger Docker's "Duplicate mount point" (if equal)
 * or produce a confusing RO overlay on top of the RW repo (if nested).
 *
 * This pre-filter drops subsumed marketplaces and emits a warning that calls
 * out the HEAD-only semantics: `git clone --shared` checks out HEAD, so files
 * that are uncommitted / untracked / .gitignore'd in the host marketplace
 * tree are not visible in the container. This matches every other file inside
 * a ccairgap repo.
 *
 * **Invariant:** Both `marketplaces` and `repoHostPaths` MUST be canonical
 * (realpath-resolved). `discoverLocalMarketplaces` does this via
 * `realpathSync` (plugins.ts); `launch.ts` realpaths repo host paths before
 * constructing `RepoPlan`. If a caller passed raw symlinked paths, the
 * subsumption check would miss collisions and the duplicate-mount bug would
 * resurface.
 */

export interface FilterSubsumedMarketplacesResult {
  /** Marketplace paths that survive the filter. */
  marketplaces: string[];
  /** User-facing warnings (one per dropped marketplace). */
  warnings: string[];
}

function isSubpath(child: string, parent: string): boolean {
  if (child === parent) return true;
  const p = parent.endsWith("/") ? parent : parent + "/";
  return child.startsWith(p);
}

export function filterSubsumedMarketplaces(
  marketplaces: string[],
  repoHostPaths: string[],
): FilterSubsumedMarketplacesResult {
  const surviving: string[] = [];
  const warnings: string[] = [];
  for (const m of marketplaces) {
    const owner = repoHostPaths.find((r) => isSubpath(m, r));
    if (owner) {
      warnings.push(
        `dropping plugin marketplace mount ${m}: subsumed by --repo/--extra-repo ${owner}. ` +
          `The container will see the repo's session-clone (committed HEAD) view of this path. ` +
          `Uncommitted changes in ${m} will not be visible until committed.`,
      );
      continue;
    }
    surviving.push(m);
  }
  return { marketplaces: surviving, warnings };
}
```

Run: `cd /Users/alfredvc/src/ccairgap && npx vitest run src/marketplaces.test.ts`

Expected: all 6 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/marketplaces.ts src/marketplaces.test.ts
git commit -m "feat(mounts): pre-filter drops marketplaces subsumed by a --repo tree"
```

---

