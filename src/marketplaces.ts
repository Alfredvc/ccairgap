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
