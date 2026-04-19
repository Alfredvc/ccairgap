# Mount Collision Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use agentfiles:subagent-driven-development (recommended) or agentfiles:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate all classes of Docker `-v` destination collisions in ccairgap's mount pipeline (duplicate-mount errors + silent-override bugs) and the closely-related on-disk scratch-path collisions they expose.

**Architecture:** (1) Drop plugin marketplaces that are subsumed by a `--repo`/`--extra-repo` path in a dedicated pre-filter *before* `resolveArtifacts` runs, so every downstream consumer sees a consistent marketplace list. (2) Enrich `Mount` with source metadata and run a defense-in-depth collision-resolution pass at the end of `buildMounts`: exact-`dst` dedup with source-aware error messages + a reserved-dst guard. (3) Fix the symlink-bypass in the upstream repo/ro overlap check (`resolve()` → `realpath()`) while preserving the existing nice error for nonexistent paths. (4) Extend `resolveArtifacts` to include (pre-filtered) marketplaces in its overlap set. (5) Disambiguate `<basename>` in `/host-git-alternates/<name>`, the session clone directory, and the hook/MCP policy scratch dirs so two repos sharing a basename cannot collide.

**Tech Stack:** TypeScript, ESM, Node ≥ 20, vitest, tsup. Existing runtime deps only (no new packages).

---

## Collision classes addressed

| Class | Description | Resolution |
|---|---|---|
| 1 | marketplace ∩ repo (exact or marketplace ⊆ repo) | Pre-filter drops marketplace; warn. Repo RW session clone covers the path. |
| 2 | marketplace ∩ `--ro` (exact `dst`) | `resolveArtifacts` overlap check errors with both labels. |
| 4 | `--ro` ∩ repo via symlink | `validateRepoRoOverlap` uses `realpath()`; preserves ENOENT-as-user-error. |
| 6 | `--mount` ∩ repo via symlink | Same fix as class 4 (shared pipeline). |
| 8 | `--mount` ∩ marketplace | `resolveArtifacts` overlap set extended to include marketplaces. |
| 9 | two repos sharing a basename (alternates dst, session clone dir, policy scratch dir) | Append `<sha256(hostPath)[:8]>` to every basename-keyed path. |
| 10/11 | user mount on reserved container path (`/output`, `/host-claude*`, `/home/claude/.claude/...`, `/host-git-alternates/*`) | `resolveMountCollisions` errors if any user-source mount uses a reserved `dst`. |

**Out of scope (intentional):**
- Class 3 (marketplace nested inside `--ro` as different `dst` strings) — Docker accepts, semantically the same data via two paths.
- Class 5 (`--ro` nested inside `--ro`) — Docker accepts, user's explicit request.
- Class 12 (hook/MCP `overrideMounts` nested inside repo/marketplace) — intentional single-file overlays per SPEC.
- Class 13 (`--cp`/`--sync` outside-repo paths) — already guarded by `mark()`; symlink case rides on the class 4/6 fix.

### Semantic trade-off acknowledged (class 1 drop policy)

When a plugin marketplace equals or is nested inside the workspace repo, we drop the marketplace mount and let the repo's session-clone RW mount serve those files. The session clone contains committed HEAD content only — uncommitted / untracked / `.gitignore`'d files in the marketplace tree will NOT be visible inside the container. This matches the existing semantics of every other file inside a repo under ccairgap (the container always sees the HEAD snapshot, never the host working tree) and is therefore consistent with user expectations; the warning we print mentions this explicitly so users who iterate on plugins know to commit first.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/mounts.ts` | Raw mount push list + exported reserved-dst set + collision resolver call | Add `source` field to `Mount`; annotate all pushes; add `alternatesName` to `BuildMountsInput.repos`; return `{mounts, warnings}`; call new `resolveMountCollisions` at end. |
| `src/mountCollisions.ts` | Policy: exact-`dst` dedup + reserved-dst guard | NEW |
| `src/mountCollisions.test.ts` | Unit tests | NEW |
| `src/mounts.test.ts` | Integration test: buildMounts end-to-end with collision scenarios | NEW |
| `src/alternatesName.ts` | Pure helper: unique, FS-safe segment `<basename>-<sha256(hostPath)[:8]>` | NEW |
| `src/alternatesName.test.ts` | Unit tests | NEW |
| `src/marketplaces.ts` | Pre-filter: drop marketplaces subsumed by any repo `hostPath`; emit warnings | NEW |
| `src/marketplaces.test.ts` | Unit tests for pre-filter | NEW |
| `src/launch.ts` | Threads `alternatesName` through `RepoPlan`; calls `filterSubsumedMarketplaces` before `resolveArtifacts`; uses `realpath()` in overlap guard; consumes new `buildMounts` return shape; populates `alternates_name` in manifest | Modifications throughout |
| `src/artifacts.ts` | Overlap detection includes (pre-filtered) marketplaces; extraMounts carry a `source` | Add `marketplaces: string[]` input; extend `mark()` loop; annotate extraMounts |
| `src/manifest.ts` | Persist `alternates_name` on disk so handoff/orphans can reconstruct the session-clone path | Additive optional `alternates_name?: string` field on `ManifestV1.repos[]` (no version bump) |
| `src/handoff.ts` | Reconstruct session clone path using `alternates_name ?? basename` | Change line 150 |
| `src/orphans.ts` | Same fallback when counting commits for stale sessions | Change line 47 |
| `src/artifacts.test.ts` | Tests for marketplace overlap; fixtures updated for `source` field | Add cases, loosen `.toEqual` → `.toMatchObject` where appropriate |
| `src/hooks.ts` | Annotate `overrideMounts` with `MountSource`; use `alternatesName` as policy-scratch dir segment | Modify three push sites + `policyDir/projects/<alt>/…` |
| `src/mcp.ts` | Same as hooks.ts | Same |
| `src/launch.test.ts` | Unit tests for `validateRepoRoOverlap` (including real tmpdir symlink + ENOENT cases) | NEW |
| `docs/SPEC.md` | Document alternates path change, collision policy, marketplace-drop rule | Update §"Container mount manifest", §"Repository access mechanism", §"Plugin marketplace discovery" |
| `CLAUDE.md` | Invariant notes | Add |

---

### Task 1: Add `MountSource` metadata to `Mount` type

**Depends on:** nothing
**Commit:** implementer
**Files:**
- Modify: `src/mounts.ts`
- Modify: `src/hooks.ts` (three `overrideMounts.push` sites)
- Modify: `src/mcp.ts` (three `overrideMounts.push` sites)
- Modify: `src/artifacts.ts` (two `extraMounts.push` sites)
- Modify: `src/artifacts.test.ts`, `src/hooks.test.ts`, `src/mcp.test.ts` (fixture churn)

#### Steps

- [ ] **Step 1: Add `MountSource` type and extend `Mount`**

Edit `src/mounts.ts` — replace the top (lines 1-12) with:

```typescript
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Tagged origin of a mount. Carried on every `Mount` so the collision resolver
 * can emit source-aware error messages and the reserved-dst guard can
 * distinguish ccairgap-owned mounts from user-supplied ones.
 */
export type MountSource =
  | { kind: "host-claude" | "host-claude-json" | "host-creds" | "patched-settings" | "patched-claude-json" | "plugins-cache" | "transcripts" | "output" }
  | { kind: "repo"; hostPath: string }
  | { kind: "alternates"; repoHostPath: string; category: "objects" | "lfs" }
  | { kind: "ro"; path: string }
  | { kind: "marketplace"; path: string }
  | { kind: "artifact"; flag: "cp" | "sync" | "mount"; raw: string }
  | { kind: "hook-override"; description: string }
  | { kind: "mcp-override"; description: string };

export type Mount = {
  src: string;
  dst: string;
  mode: "ro" | "rw";
  source: MountSource;
};

export function mountArg(m: Mount): string[] {
  return ["-v", `${m.src}:${m.dst}:${m.mode}`];
}
```

- [ ] **Step 2: Extend `BuildMountsInput.repos` to include `alternatesName`**

Edit `src/mounts.ts` — change lines 35-40:

```typescript
  repos: Array<{
    basename: string;
    sessionClonePath: string;
    hostPath: string;
    realGitDir: string;
    /** Unique-per-repo segment used in `/host-git-alternates/<alternatesName>/…`. Must not collide across repos. Produced by `alternatesName()`. */
    alternatesName: string;
  }>;
```

- [ ] **Step 3: Annotate every push in `buildMounts`**

Edit `src/mounts.ts` — replace the body of `buildMounts` (lines 52-128) with:

```typescript
export function buildMounts(i: BuildMountsInput): Mount[] {
  const mounts: Mount[] = [];

  mounts.push({ src: i.hostClaudeDir, dst: "/host-claude", mode: "ro", source: { kind: "host-claude" } });
  mounts.push({ src: i.hostClaudeJson, dst: "/host-claude-json", mode: "ro", source: { kind: "host-claude-json" } });
  mounts.push({ src: i.hostCredsFile, dst: "/host-claude-creds", mode: "ro", source: { kind: "host-creds" } });
  if (i.hostPatchedUserSettings) {
    mounts.push({ src: i.hostPatchedUserSettings, dst: "/host-claude-patched-settings.json", mode: "ro", source: { kind: "patched-settings" } });
  }
  if (i.hostPatchedClaudeJson) {
    mounts.push({ src: i.hostPatchedClaudeJson, dst: "/host-claude-patched-json", mode: "ro", source: { kind: "patched-claude-json" } });
  }

  if (existsSync(i.pluginsCacheDir)) {
    mounts.push({
      src: i.pluginsCacheDir,
      dst: join(i.homeInContainer, ".claude", "plugins", "cache"),
      mode: "ro",
      source: { kind: "plugins-cache" },
    });
  }

  mounts.push({
    src: i.sessionTranscriptsDir,
    dst: join(i.homeInContainer, ".claude", "projects"),
    mode: "rw",
    source: { kind: "transcripts" },
  });

  mounts.push({ src: i.outputDir, dst: "/output", mode: "rw", source: { kind: "output" } });

  for (const r of i.repos) {
    mounts.push({ src: r.sessionClonePath, dst: r.hostPath, mode: "rw", source: { kind: "repo", hostPath: r.hostPath } });

    const objDir = join(r.realGitDir, "objects");
    if (existsSync(objDir)) {
      mounts.push({
        src: objDir,
        dst: `/host-git-alternates/${r.alternatesName}/objects`,
        mode: "ro",
        source: { kind: "alternates", repoHostPath: r.hostPath, category: "objects" },
      });
    }

    const lfsDir = join(r.realGitDir, "lfs", "objects");
    if (existsSync(lfsDir)) {
      mounts.push({
        src: lfsDir,
        dst: `/host-git-alternates/${r.alternatesName}/lfs/objects`,
        mode: "ro",
        source: { kind: "alternates", repoHostPath: r.hostPath, category: "lfs" },
      });
    }
  }

  for (const p of i.roPaths) {
    mounts.push({ src: p, dst: p, mode: "ro", source: { kind: "ro", path: p } });
  }

  for (const p of i.pluginMarketplaces) {
    mounts.push({ src: p, dst: p, mode: "ro", source: { kind: "marketplace", path: p } });
  }

  if (i.extraMounts) {
    for (const m of i.extraMounts) mounts.push(m);
  }

  return mounts;
}
```

- [ ] **Step 4: Annotate hook-override pushes**

Edit `src/hooks.ts` — three `overrideMounts.push` sites. For each, add a `source` field. Use labels that identify the settings file being overlaid.

Line ~451 (plugin-cache hooks.json overlay, inside the `for (const p of plugins)` loop):
```typescript
overrideMounts.push({
  src: outPath,
  dst: join(p.containerDir, "hooks", "hooks.json"),
  mode: "ro",
  source: { kind: "hook-override", description: `plugin ${p.marketplace}/${p.plugin}@${p.version} hooks.json` },
});
```

Line ~478 (dir-plugin hooks overlay, inside `for (const dp of listDirectoryPlugins(...))`):
```typescript
overrideMounts.push({
  src: outPath,
  dst: dp.hooksJsonPath,
  mode: "ro",
  source: { kind: "hook-override", description: `dir-plugin ${dp.marketplace}/${dp.plugin} hooks.json` },
});
```

Line ~500 (project settings overlay, inside `for (const r of repos)`):
```typescript
overrideMounts.push({
  src: outPath,
  dst: join(r.hostPath, ".claude", fname),
  mode: "ro",
  source: { kind: "hook-override", description: `project ${r.basename} .claude/${fname}` },
});
```

Read the file around the referenced lines first to match the exact surrounding variables — the plugin loop uses `p.marketplace`/`p.plugin`/`p.version`/`p.containerDir`; the dir-plugin loop uses `dp.marketplace`/`dp.plugin`/`dp.hooksJsonPath`; the project loop uses `r.basename`/`r.hostPath`.

- [ ] **Step 5: Annotate MCP-override pushes**

Edit `src/mcp.ts` — three `overrideMounts.push` sites (lines ~421, ~444, ~500). Same pattern: add `source: { kind: "mcp-override", description: ... }` with a descriptive label naming the file being overlaid.

- [ ] **Step 6: Annotate artifact extraMounts**

Edit `src/artifacts.ts` — replace lines 149-162 with:

```typescript
  const extraMounts: Mount[] = [];
  const syncRecords: ResolveArtifactsResult["syncRecords"] = [];
  for (const e of entries) {
    if (e.kind === "mount") {
      extraMounts.push({
        src: e.srcHost,
        dst: e.containerPath,
        mode: "rw",
        source: { kind: "artifact", flag: "mount", raw: e.raw },
      });
    } else if (!e.insideRepoClone && e.sessionSrc) {
      extraMounts.push({
        src: e.sessionSrc,
        dst: e.containerPath,
        mode: "rw",
        source: { kind: "artifact", flag: e.kind, raw: e.raw },
      });
    }
    if (e.kind === "sync" && e.sessionSrc) {
      syncRecords.push({ src_host: e.srcHost, session_src: e.sessionSrc });
    }
  }
```

- [ ] **Step 7: Fix existing test fixtures that exact-match `Mount` literals**

Edit `src/artifacts.test.ts`:

Line 70-72 — replace `toEqual` with `toMatchObject` (we don't want to pin the `source` shape in legacy tests that aren't focused on it):

```typescript
    expect(r.extraMounts).toMatchObject([
      { src: e.sessionSrc!, dst: outside, mode: "rw" },
    ]);
```

Line 165-167 — same change:

```typescript
    expect(r.extraMounts).toMatchObject([
      { src: join(repoPath, "node_modules"), dst: join(repoPath, "node_modules"), mode: "rw" },
    ]);
```

Run a grep-style audit to catch anything missed:

```bash
cd /Users/alfredvc/src/ccairgap
# find every literal Mount-like construction in tests
Grep -rn "dst:.*mode:" src --include="*.test.ts"
```

Apply the same loosening to any result that constructs a full-shape assertion of a `Mount`.

For `src/hooks.test.ts` and `src/mcp.test.ts`: current assertions on `overrideMounts[n]` are either `toMatchObject`-style or access individual fields (`pm.src`, `pm.dst`). Adding a required `source` field only breaks `toEqual({src, dst, mode})` calls — use `toMatchObject` or extend the assertion to include the expected `source: { kind: "hook-override", description: expect.any(String) }`.

- [ ] **Step 8: Typecheck and run tests**

Run: `cd /Users/alfredvc/src/ccairgap && npm run typecheck && npm test`

Expected: all passes. This is a pure metadata refactor — no behavior change.

- [ ] **Step 9: Commit**

```bash
git add src/mounts.ts src/hooks.ts src/mcp.ts src/artifacts.ts src/artifacts.test.ts src/hooks.test.ts src/mcp.test.ts
git commit -m "refactor(mounts): tag every Mount with a MountSource for collision diagnostics"
```

---

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

### Task 3: Write failing tests for `resolveMountCollisions`

**Depends on:** Task 1
**Parallel with:** Task 2, Task 4
**Commit:** implementer
**Files:**
- Create: `src/mountCollisions.test.ts`

#### Steps

- [ ] **Step 1: Write the test file**

Create `src/mountCollisions.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { resolveMountCollisions, reservedContainerPaths } from "./mountCollisions.js";
import type { Mount } from "./mounts.js";

const HOME_IN_CONTAINER = "/home/claude";

const repoMount = (hostPath: string, src = hostPath + "/.clone"): Mount => ({
  src,
  dst: hostPath,
  mode: "rw",
  source: { kind: "repo", hostPath },
});
const marketMount = (p: string): Mount => ({
  src: p,
  dst: p,
  mode: "ro",
  source: { kind: "marketplace", path: p },
});
const roMount = (p: string): Mount => ({
  src: p,
  dst: p,
  mode: "ro",
  source: { kind: "ro", path: p },
});
const mountFlag = (raw: string, dst: string): Mount => ({
  src: dst,
  dst,
  mode: "rw",
  source: { kind: "artifact", flag: "mount", raw },
});
const outputMount = (): Mount => ({
  src: "/host/out",
  dst: "/output",
  mode: "rw",
  source: { kind: "output" },
});
const transcriptsMount = (): Mount => ({
  src: "/host/transcripts",
  dst: `${HOME_IN_CONTAINER}/.claude/projects`,
  mode: "rw",
  source: { kind: "transcripts" },
});

describe("resolveMountCollisions", () => {
  it("passes through a non-colliding list unchanged", () => {
    const mounts: Mount[] = [repoMount("/a"), roMount("/b")];
    const r = resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER });
    expect(r.mounts).toEqual(mounts);
  });

  it("throws on exact dst collision between two user mounts", () => {
    const mounts: Mount[] = [roMount("/x"), marketMount("/x")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /duplicate container path \/x.*--ro.*marketplace/,
    );
  });

  it("throws on exact dst collision between --mount and a repo", () => {
    const mounts: Mount[] = [repoMount("/r"), mountFlag("x", "/r")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /duplicate container path \/r.*--repo.*--mount/,
    );
  });

  it("throws on two repo entries with identical dst (defense-in-depth vs symlink bypass)", () => {
    const mounts: Mount[] = [repoMount("/a"), repoMount("/a")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /duplicate container path \/a/,
    );
  });

  it("allows two alternates mounts with different alternatesName segments", () => {
    const a: Mount = {
      src: "/host/a/.git/objects",
      dst: "/host-git-alternates/a-00000000/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host/a", category: "objects" },
    };
    const b: Mount = {
      src: "/host/b/.git/objects",
      dst: "/host-git-alternates/b-11111111/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host/b", category: "objects" },
    };
    const r = resolveMountCollisions([a, b], { homeInContainer: HOME_IN_CONTAINER });
    expect(r.mounts).toHaveLength(2);
  });

  it("throws if two alternates mounts collide (alternatesName bug regression test)", () => {
    const a: Mount = {
      src: "/host/a/.git/objects",
      dst: "/host-git-alternates/myrepo-deadbeef/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host/a/myrepo", category: "objects" },
    };
    const b: Mount = {
      src: "/host/b/.git/objects",
      dst: "/host-git-alternates/myrepo-deadbeef/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host/b/myrepo", category: "objects" },
    };
    expect(() => resolveMountCollisions([a, b], { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /duplicate container path.*myrepo-deadbeef/,
    );
  });

  it("errors on --ro colliding with /output", () => {
    const mounts: Mount[] = [outputMount(), roMount("/output")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /\/output.*reserved.*--ro/,
    );
  });

  it("errors on --mount colliding with /host-claude", () => {
    const host: Mount = {
      src: "/real/.claude",
      dst: "/host-claude",
      mode: "ro",
      source: { kind: "host-claude" },
    };
    const mounts: Mount[] = [host, mountFlag("weird", "/host-claude")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /\/host-claude.*reserved/,
    );
  });

  it("errors on user mount using a reserved homeInContainer path", () => {
    const mounts: Mount[] = [
      transcriptsMount(),
      roMount(`${HOME_IN_CONTAINER}/.claude/projects`),
    ];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /\.claude\/projects.*reserved/,
    );
  });

  it("errors on user mount using a path under /host-git-alternates", () => {
    const alt: Mount = {
      src: "/host/.git/objects",
      dst: "/host-git-alternates/myrepo-aa/objects",
      mode: "ro",
      source: { kind: "alternates", repoHostPath: "/host", category: "objects" },
    };
    const mounts: Mount[] = [alt, roMount("/host-git-alternates/myrepo-aa/objects")];
    expect(() => resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER })).toThrow(
      /host-git-alternates/,
    );
  });

  it("does not reorder surviving mounts", () => {
    const mounts: Mount[] = [outputMount(), repoMount("/r"), roMount("/x"), mountFlag("m", "/y")];
    const r = resolveMountCollisions(mounts, { homeInContainer: HOME_IN_CONTAINER });
    expect(r.mounts.map((m) => m.dst)).toEqual(["/output", "/r", "/x", "/y"]);
  });

  it("exposes the reserved-path set for external consumers (stability check)", () => {
    const reserved = reservedContainerPaths({ homeInContainer: HOME_IN_CONTAINER });
    expect(reserved.exact).toEqual(
      expect.arrayContaining([
        "/output",
        "/host-claude",
        "/host-claude-json",
        "/host-claude-creds",
        "/host-claude-patched-settings.json",
        "/host-claude-patched-json",
        `${HOME_IN_CONTAINER}/.claude/projects`,
        `${HOME_IN_CONTAINER}/.claude/plugins/cache`,
      ]),
    );
    expect(reserved.prefixes).toEqual(expect.arrayContaining(["/host-git-alternates"]));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/alfredvc/src/ccairgap && npx vitest run src/mountCollisions.test.ts`

Expected: all tests fail (module does not exist).

- [ ] **Step 3: Commit failing tests**

```bash
git add src/mountCollisions.test.ts
git commit -m "test(mounts): failing tests for mount-collision resolver"
```

---

### Task 4: Implement `resolveMountCollisions`

**Depends on:** Task 3
**Commit:** implementer
**Files:**
- Create: `src/mountCollisions.ts`

#### Steps

- [ ] **Step 1: Create the implementation**

Create `src/mountCollisions.ts`:

```typescript
import { join } from "node:path";
import type { Mount, MountSource } from "./mounts.js";

export interface ReservedContainerPathsInput {
  homeInContainer: string;
}

export interface ReservedContainerPaths {
  /** Exact `dst` values a user mount may not use. */
  exact: string[];
  /** `dst` prefixes a user mount may not live under. */
  prefixes: string[];
}

/**
 * The set of container paths ccairgap controls. User-supplied mounts
 * (`--ro`, `--mount`, `--repo`, `--extra-repo`, discovered marketplaces) may
 * not collide with these. Exposed as a separate helper so consumers (tests,
 * documentation generators) can enumerate the stable list.
 */
export function reservedContainerPaths(
  i: ReservedContainerPathsInput,
): ReservedContainerPaths {
  return {
    exact: [
      "/output",
      "/host-claude",
      "/host-claude-json",
      "/host-claude-creds",
      "/host-claude-patched-settings.json",
      "/host-claude-patched-json",
      join(i.homeInContainer, ".claude", "projects"),
      join(i.homeInContainer, ".claude", "plugins", "cache"),
    ],
    prefixes: ["/host-git-alternates"],
  };
}

/** Source kinds whose `dst` ultimately comes from user input (CLI, config, settings.json). */
const USER_SOURCE_KINDS = new Set<MountSource["kind"]>([
  "repo",
  "ro",
  "marketplace",
  "artifact",
]);

function label(src: MountSource): string {
  switch (src.kind) {
    case "repo": return `--repo/--extra-repo ${src.hostPath}`;
    case "ro": return `--ro ${src.path}`;
    case "marketplace": return `plugin marketplace ${src.path}`;
    case "artifact": return `--${src.flag} ${src.raw}`;
    case "alternates": return `git alternates for ${src.repoHostPath} (${src.category})`;
    case "hook-override": return `hook override (${src.description})`;
    case "mcp-override": return `mcp override (${src.description})`;
    case "host-claude": return `~/.claude RO mount`;
    case "host-claude-json": return `~/.claude.json RO mount`;
    case "host-creds": return `credentials RO mount`;
    case "patched-settings": return `patched user settings`;
    case "patched-claude-json": return `patched ~/.claude.json`;
    case "plugins-cache": return `plugins cache RO mount`;
    case "transcripts": return `transcripts RW mount`;
    case "output": return `/output RW mount`;
  }
}

function isUnderPrefix(dst: string, prefix: string): boolean {
  if (dst === prefix) return true;
  const p = prefix.endsWith("/") ? prefix : prefix + "/";
  return dst.startsWith(p);
}

export interface ResolveMountCollisionsResult {
  mounts: Mount[];
  /** Warnings from collision resolution (currently empty — reserved for future policy rules). */
  warnings: string[];
}

export interface ResolveMountCollisionsInput {
  homeInContainer: string;
}

/**
 * Defense-in-depth collision resolution:
 *
 * 1. **Exact `dst` dedup.** Any two mounts sharing a container path throw with
 *    both source labels. Upstream validation (the marketplace pre-filter,
 *    `resolveArtifacts` overlap check, `validateRepoRoOverlap`) should catch
 *    every case before we get here — this pass is the backstop.
 *
 * 2. **Reserved-dst guard.** User-sourced mounts may not use a path reserved
 *    by ccairgap (`/output`, `/host-claude*`, `<home>/.claude/projects`,
 *    `<home>/.claude/plugins/cache`, anything under `/host-git-alternates`).
 *
 * Nested mounts with distinct `dst` strings (e.g. hook/MCP single-file overlays
 * on top of a repo, `--mount` paths inside a repo) are **allowed** — they're
 * the intended overlay mechanism and Docker handles them correctly.
 */
export function resolveMountCollisions(
  mounts: Mount[],
  i: ResolveMountCollisionsInput,
): ResolveMountCollisionsResult {
  // 1. Exact dst dedup.
  const seen = new Map<string, Mount>();
  for (const m of mounts) {
    const prev = seen.get(m.dst);
    if (prev) {
      throw new Error(
        `duplicate container path ${m.dst}: ${label(prev.source)} vs ${label(m.source)}`,
      );
    }
    seen.set(m.dst, m);
  }

  // 2. Reserved-dst guard.
  const reserved = reservedContainerPaths({ homeInContainer: i.homeInContainer });
  const reservedExact = new Set(reserved.exact);
  for (const m of mounts) {
    if (!USER_SOURCE_KINDS.has(m.source.kind)) continue;
    if (reservedExact.has(m.dst)) {
      throw new Error(
        `${m.dst} is a reserved container path; ${label(m.source)} cannot use it`,
      );
    }
    for (const p of reserved.prefixes) {
      if (isUnderPrefix(m.dst, p)) {
        throw new Error(
          `${m.dst} is under reserved prefix ${p}; ${label(m.source)} cannot use it`,
        );
      }
    }
  }

  return { mounts, warnings: [] };
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/alfredvc/src/ccairgap && npx vitest run src/mountCollisions.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/mountCollisions.ts
git commit -m "feat(mounts): collision resolver with exact-dst dedup + reserved-path guard"
```

---

### Task 5: Implement `alternatesName` helper

**Depends on:** Task 1
**Parallel with:** Tasks 2, 3, 4
**Commit:** implementer
**Files:**
- Create: `src/alternatesName.ts`
- Create: `src/alternatesName.test.ts`

#### Steps

- [ ] **Step 1: Write failing tests**

Create `src/alternatesName.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { alternatesName } from "./alternatesName.js";

describe("alternatesName", () => {
  it("produces a name of the form <basename>-<8hex>", () => {
    const n = alternatesName("myrepo", "/work/a/myrepo");
    expect(n).toMatch(/^myrepo-[0-9a-f]{8}$/);
  });

  it("returns distinct names for two repos sharing a basename", () => {
    const a = alternatesName("myrepo", "/work/a/myrepo");
    const b = alternatesName("myrepo", "/work/b/myrepo");
    expect(a).not.toBe(b);
  });

  it("is deterministic for the same input", () => {
    const a = alternatesName("myrepo", "/work/a/myrepo");
    const b = alternatesName("myrepo", "/work/a/myrepo");
    expect(a).toBe(b);
  });

  it("sanitises unsafe characters in basenames", () => {
    const n = alternatesName("weird name:1", "/x/weird name:1");
    expect(n).toMatch(/^[A-Za-z0-9._-]+-[0-9a-f]{8}$/);
  });
});
```

Run: `cd /Users/alfredvc/src/ccairgap && npx vitest run src/alternatesName.test.ts`

Expected: all 4 tests fail.

- [ ] **Step 2: Implement**

Create `src/alternatesName.ts`:

```typescript
import { createHash } from "node:crypto";

/**
 * Unique, filesystem-safe segment for per-repo scratch paths: the
 * `/host-git-alternates/<alternatesName>/…` Docker mount, the session clone
 * directory (`$SESSION/repos/<alternatesName>`), and the hook/MCP policy scratch
 * dir (`$SESSION/policy/hooks|mcp/projects/<alternatesName>`).
 *
 * Two repos sharing a `basename(hostPath)` would otherwise collide on all
 * three. The 8-hex slice of sha256(hostPath) disambiguates while the leading
 * basename keeps logs readable.
 */
export function alternatesName(basename: string, hostPath: string): string {
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, "_");
  const hash = createHash("sha256").update(hostPath).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}
```

Run: `cd /Users/alfredvc/src/ccairgap && npx vitest run src/alternatesName.test.ts`

Expected: all 4 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/alternatesName.ts src/alternatesName.test.ts
git commit -m "feat(paths): alternatesName helper for unique per-repo scratch segments"
```

---

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

### Task 7: Fix `resolve()` → `realpath()` in the repo/ro overlap guard

**Depends on:** Task 1
**Parallel with:** Tasks 2-6
**Commit:** implementer
**Files:**
- Modify: `src/launch.ts`
- Create: `src/launch.test.ts`

#### Steps

- [ ] **Step 1: Extract the overlap check as an exported helper**

Edit `src/launch.ts` — above the `launch` function (around line 117), add:

```typescript
/**
 * Validates that `opts.repos` entries resolve to distinct real paths and that
 * no `opts.ros` entry resolves to the same real path as any repo. Uses
 * `realpath()` so a symlinked form of a real path is caught.
 *
 * Preserves the existing UX: if a path does not exist, `realpath()` throws
 * ENOENT — we catch that and rethrow with the same "path does not exist"
 * message the downstream existence checks (`resolveGitDir`, `--ro` existsSync)
 * would produce. The validation order is therefore: existence → real-path
 * equality, not the other way around.
 */
export function validateRepoRoOverlap(
  repos: string[],
  ros: string[],
  resolveRealpath: (p: string) => string,
): void {
  const resolveOr = (label: string, p: string): string => {
    try {
      return resolveRealpath(p);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new Error(`${label} path does not exist: ${p}`);
      }
      throw e;
    }
  };

  const repoSet = new Set<string>();
  for (const r of repos) {
    const real = resolveOr("--repo/--extra-repo", r);
    if (repoSet.has(real)) {
      throw new Error(`duplicate repo path in --repo/--extra-repo: ${r} (resolves to ${real})`);
    }
    repoSet.add(real);
  }
  for (const ro of ros) {
    const real = resolveOr("--ro", ro);
    if (repoSet.has(real)) {
      throw new Error(
        `path appears in both repo (--repo/--extra-repo) and --ro: ${ro} (resolves to ${real})`,
      );
    }
  }
}
```

Replace the inline check at lines 132-145 with:

```typescript
  try {
    validateRepoRoOverlap(opts.repos, opts.ros, realpath);
  } catch (e) {
    die((e as Error).message);
  }
```

`realpath` is already imported from `./paths.js`.

Note: `launch.ts:175` (`resolveGitDir`) and `launch.ts:192` (`existsSync` check on `--ro` paths) still run after this. They become effectively unreachable for the "path does not exist" case (we've already thrown a nicer message), but leave them in place — they stay correct for the "exists but isn't a git repo" case (`resolveGitDir`) and serve as defense-in-depth. Do NOT delete them.

- [ ] **Step 2: Write tests (with both fake-realpath and real-fs coverage)**

Create `src/launch.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRepoRoOverlap } from "./launch.js";

const fakeRealpath = (map: Record<string, string>) => (p: string) => {
  if (!(p in map)) {
    const err = new Error(`ENOENT: no such file or directory, realpath '${p}'`) as NodeJS.ErrnoException;
    err.code = "ENOENT";
    throw err;
  }
  return map[p]!;
};

describe("validateRepoRoOverlap (unit)", () => {
  it("accepts disjoint repo and ro sets", () => {
    const rp = fakeRealpath({ "/a": "/a", "/b": "/b", "/c": "/c" });
    expect(() => validateRepoRoOverlap(["/a", "/b"], ["/c"], rp)).not.toThrow();
  });

  it("errors on identical repo paths", () => {
    const rp = fakeRealpath({ "/a": "/a" });
    expect(() => validateRepoRoOverlap(["/a", "/a"], [], rp)).toThrow(/duplicate repo path/);
  });

  it("errors when two symlinked repo paths resolve to the same real path", () => {
    const rp = fakeRealpath({ "/sym1": "/real", "/sym2": "/real" });
    expect(() => validateRepoRoOverlap(["/sym1", "/sym2"], [], rp)).toThrow(
      /duplicate repo path/,
    );
  });

  it("errors when --ro is a symlink pointing at a repo real path", () => {
    const rp = fakeRealpath({ "/sym": "/real", "/real": "/real" });
    expect(() => validateRepoRoOverlap(["/sym"], ["/real"], rp)).toThrow(
      /appears in both repo .* and --ro/,
    );
  });

  it("errors when --repo is a symlink pointing at a --ro real path", () => {
    const rp = fakeRealpath({ "/sym": "/real", "/real": "/real" });
    expect(() => validateRepoRoOverlap(["/sym"], ["/real"], rp)).toThrow(
      /appears in both repo .* and --ro/,
    );
  });

  it("errors cleanly on nonexistent --repo path (preserves UX)", () => {
    const rp = fakeRealpath({});
    expect(() => validateRepoRoOverlap(["/typo"], [], rp)).toThrow(
      /--repo\/--extra-repo path does not exist: \/typo/,
    );
  });

  it("errors cleanly on nonexistent --ro path (preserves UX)", () => {
    const rp = fakeRealpath({ "/a": "/a" });
    expect(() => validateRepoRoOverlap(["/a"], ["/nope"], rp)).toThrow(
      /--ro path does not exist: \/nope/,
    );
  });
});

describe("validateRepoRoOverlap (integration with real fs)", () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-overlap-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("catches a symlinked --ro that points at a real --repo path", () => {
    const real = join(root, "realrepo");
    mkdirSync(real, { recursive: true });
    const sym = join(root, "sym");
    symlinkSync(real, sym);
    expect(() => validateRepoRoOverlap([real], [sym], realpathSync)).toThrow(
      /appears in both repo .* and --ro/,
    );
  });

  it("catches a symlinked --repo whose target equals another --repo", () => {
    const real = join(root, "r");
    mkdirSync(real, { recursive: true });
    const sym = join(root, "s");
    symlinkSync(real, sym);
    expect(() => validateRepoRoOverlap([real, sym], [], realpathSync)).toThrow(
      /duplicate repo path/,
    );
  });
});
```

Run: `cd /Users/alfredvc/src/ccairgap && npx vitest run src/launch.test.ts`

Expected: all 9 tests pass (the helper is already implemented from Step 1).

- [ ] **Step 3: Run full test suite**

Run: `cd /Users/alfredvc/src/ccairgap && npm test`

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/launch.ts src/launch.test.ts
git commit -m "fix(launch): use realpath in repo/ro overlap guard; preserve ENOENT UX"
```

---

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

### Task 9: Wire `resolveMountCollisions` into `buildMounts`

**Depends on:** Tasks 1, 4, 5, 6
**Commit:** implementer
**Files:**
- Modify: `src/mounts.ts`
- Modify: `src/launch.ts`
- Create: `src/mounts.test.ts`

#### Steps

- [ ] **Step 1: Write integration test**

Create `src/mounts.test.ts`:

```typescript
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMounts, type Mount } from "./mounts.js";

let root: string;

function baseInput(r: string) {
  mkdirSync(join(r, "claude"), { recursive: true });
  mkdirSync(join(r, "transcripts"), { recursive: true });
  mkdirSync(join(r, "output"), { recursive: true });
  return {
    hostClaudeDir: join(r, "claude"),
    hostClaudeJson: join(r, "claude", ".claude.json"),
    hostCredsFile: join(r, "claude", "creds"),
    pluginsCacheDir: join(r, "claude", "nocache"), // absent → skipped
    sessionTranscriptsDir: join(r, "transcripts"),
    outputDir: join(r, "output"),
    repos: [] as Array<{
      basename: string;
      sessionClonePath: string;
      hostPath: string;
      realGitDir: string;
      alternatesName: string;
    }>,
    roPaths: [] as string[],
    pluginMarketplaces: [] as string[],
    homeInContainer: "/home/claude",
    extraMounts: [] as Mount[],
  };
}

describe("buildMounts + collision resolver", () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-mounts-")));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("produces distinct /host-git-alternates dsts for two repos sharing a basename", () => {
    const a = join(root, "a", "myrepo");
    const b = join(root, "b", "myrepo");
    mkdirSync(join(a, ".git", "objects"), { recursive: true });
    mkdirSync(join(b, ".git", "objects"), { recursive: true });
    const input = baseInput(root);
    input.repos = [
      { basename: "myrepo", sessionClonePath: join(root, "s", "a"), hostPath: a, realGitDir: join(a, ".git"), alternatesName: "myrepo-aaaaaaaa" },
      { basename: "myrepo", sessionClonePath: join(root, "s", "b"), hostPath: b, realGitDir: join(b, ".git"), alternatesName: "myrepo-bbbbbbbb" },
    ];

    const mounts = buildMounts(input);

    const altDsts = mounts.filter((m) => m.dst.startsWith("/host-git-alternates/")).map((m) => m.dst);
    expect(new Set(altDsts).size).toBe(altDsts.length);
    expect(altDsts).toContain("/host-git-alternates/myrepo-aaaaaaaa/objects");
    expect(altDsts).toContain("/host-git-alternates/myrepo-bbbbbbbb/objects");
  });

  it("throws on an exact dst collision between two marketplaces (defense-in-depth)", () => {
    const p = join(root, "mkt");
    mkdirSync(p, { recursive: true });
    const input = baseInput(root);
    input.pluginMarketplaces = [p, p];
    expect(() => buildMounts(input)).toThrow(/duplicate container path/);
  });

  it("throws on --ro reusing a reserved dst (/output)", () => {
    const input = baseInput(root);
    input.roPaths = ["/output"];
    expect(() => buildMounts(input)).toThrow(/\/output.*reserved/);
  });

  it("throws on --ro under /host-git-alternates prefix", () => {
    const input = baseInput(root);
    input.roPaths = ["/host-git-alternates/some-repo/objects"];
    expect(() => buildMounts(input)).toThrow(/host-git-alternates/);
  });
});
```

Run: `cd /Users/alfredvc/src/ccairgap && npx vitest run src/mounts.test.ts`

Expected: failures — `buildMounts` currently returns `Mount[]` directly without calling the resolver.

- [ ] **Step 2: Call `resolveMountCollisions` at the end of `buildMounts`**

Edit `src/mounts.ts` — add imports and wrap the return:

```typescript
import { resolveMountCollisions } from "./mountCollisions.js";
```

Replace `return mounts;` at the end of `buildMounts` with:

```typescript
  const resolved = resolveMountCollisions(mounts, { homeInContainer: i.homeInContainer });
  return resolved.mounts;
}
```

Return type stays `Mount[]` — callers do not need to handle warnings from this layer (the resolver currently returns no warnings; the marketplace pre-filter is the only source of warnings and it runs in `launch.ts`). If future policy rules emit warnings here, change the signature then.

- [ ] **Step 3: Wrap the `buildMounts` call site in try/catch**

Edit `src/launch.ts` — the `buildMounts(...)` call (around line 367). `buildMounts` can now throw via `resolveMountCollisions`. Wrap it:

```typescript
  let mounts: Mount[];
  try {
    mounts = buildMounts({
      hostClaudeDir: hostClaude,
      // ...all existing args unchanged...
    });
  } catch (e) {
    die((e as Error).message);
  }
```

Add `import type { Mount } from "./mounts.js";` alongside the existing `mountArg` import, or merge into a single import.

Update the subsequent `for (const m of mounts)` loop (currently line 424) — no change needed, still iterates the `mounts` array.

- [ ] **Step 4: Run full test suite**

Run: `cd /Users/alfredvc/src/ccairgap && npm run typecheck && npm test`

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mounts.ts src/mounts.test.ts src/launch.ts
git commit -m "feat(mounts): run collision resolver at end of buildMounts"
```

---

### Task 10: Manual end-to-end verification

**Depends on:** Tasks 1-9
**Commit:** n/a
**Files:** none (verification only)

#### Steps

- [ ] **Step 1: Build the bundle**

Run: `cd /Users/alfredvc/src/ccairgap && npm run build`

Expected: `dist/cli.js` regenerated, no errors.

- [ ] **Step 2: Reproduce original bug (should now succeed with a warning)**

Precondition: user's `~/.claude/settings.json` has an `extraKnownMarketplaces` entry whose `source.path` resolves to `/Users/alfredvc/src/agentfiles`. Verify:

```bash
jq -r '.extraKnownMarketplaces // {} | to_entries[] | select(.value.source.source == "directory" or .value.source.source == "file") | .value.source.path' ~/.claude/settings.json
```

Expected: list includes `/Users/alfredvc/src/agentfiles`.

Then run:

```bash
cd /Users/alfredvc/src/agentfiles
node /Users/alfredvc/src/ccairgap/dist/cli.js --ro ../claude-code
```

Expected on stderr (before the container starts):
```
ccairgap: dropping plugin marketplace mount /Users/alfredvc/src/agentfiles: subsumed by --repo/--extra-repo /Users/alfredvc/src/agentfiles. The container will see the repo's session-clone (committed HEAD) view of this path. Uncommitted changes in /Users/alfredvc/src/agentfiles will not be visible until committed.
```

Docker starts without a "Duplicate mount point" error. Exit with `Ctrl+D`.

- [ ] **Step 3: Verify alternates + session clone disambiguation with same-basename repos (incl. handoff round-trip)**

```bash
mkdir -p /tmp/ccg-test/a/myrepo /tmp/ccg-test/b/myrepo
(cd /tmp/ccg-test/a/myrepo && git init -q && git commit --allow-empty -m init -q)
(cd /tmp/ccg-test/b/myrepo && git init -q && git commit --allow-empty -m init -q)
node /Users/alfredvc/src/ccairgap/dist/cli.js --repo /tmp/ccg-test/a/myrepo --extra-repo /tmp/ccg-test/b/myrepo
```

Expected: container starts. Inside the container:

```
ls /tmp/ccg-test/a/myrepo
ls /tmp/ccg-test/b/myrepo
# Make distinguishable commits in each:
cd /tmp/ccg-test/a/myrepo && echo a > marker-a && git add -A && git commit -qm "from-a"
cd /tmp/ccg-test/b/myrepo && echo b > marker-b && git add -A && git commit -qm "from-b"
exit
```

Expected after exit (handoff round-trip):

```bash
ls ~/.local/state/ccairgap/sessions/*/repos/ 2>/dev/null || echo "session cleaned up"
git -C /tmp/ccg-test/a/myrepo branch | grep ccairgap
git -C /tmp/ccg-test/b/myrepo branch | grep ccairgap
git -C /tmp/ccg-test/a/myrepo show ccairgap/*:marker-a
git -C /tmp/ccg-test/b/myrepo show ccairgap/*:marker-b
```

Expected: each repo has a `ccairgap/<ts>` branch with ONLY its own marker file — proving handoff correctly rehydrated each repo from its disambiguated session clone directory. If `marker-a` appears in repo `b` or vice versa, the handoff/orphans propagation (Task 6 Steps 8-10) is broken.

Cleanup: `rm -rf /tmp/ccg-test`.

- [ ] **Step 4: Verify symlink bypass is now caught**

```bash
ln -sfn /Users/alfredvc/src/ccairgap /tmp/ccg-symlink
node /Users/alfredvc/src/ccairgap/dist/cli.js --repo /Users/alfredvc/src/ccairgap --ro /tmp/ccg-symlink
```

Expected stderr:
```
ccairgap: path appears in both repo (--repo/--extra-repo) and --ro: /tmp/ccg-symlink (resolves to /Users/alfredvc/src/ccairgap)
```

Exit code: 1. Cleanup: `rm /tmp/ccg-symlink`.

- [ ] **Step 5: Verify reserved-dst guard**

```bash
node /Users/alfredvc/src/ccairgap/dist/cli.js --ro /output
```

Expected stderr:
```
ccairgap: /output is a reserved container path; --ro /output cannot use it
```

Exit code: 1.

- [ ] **Step 6: Verify ENOENT UX preserved**

```bash
node /Users/alfredvc/src/ccairgap/dist/cli.js --repo /definitely/does/not/exist
```

Expected stderr:
```
ccairgap: --repo/--extra-repo path does not exist: /definitely/does/not/exist
```

Exit code: 1. No TypeScript/Node stack trace.

- [ ] **Step 7: Record results**

If any step fails, file a note against the relevant task and fix before moving on.

---

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

## Self-Review Checklist

**Spec coverage:**

| Class | Where addressed |
|---|---|
| 1 — marketplace ∩ repo | Task 2 pre-filter drops before artifacts; Task 10 Step 2 manual verification |
| 2 — marketplace ∩ --ro (exact) | Task 8 Step 2 extends `resolveArtifacts.mark` to include marketplaces |
| 4 — --ro ∩ repo symlink | Task 7 Steps 1-2 use `realpath()`; tests Step 2 cover symlink + ENOENT |
| 6 — --mount ∩ repo symlink | Same `realpath` fix via `validateRepoRoOverlap`; `resolveArtifacts` already realpath's artifact paths |
| 8 — --mount ∩ marketplace | Task 8 Steps 1-2 add marketplaces to `mark` set |
| 9 — same-basename collision | Task 5 (helper), Task 6 (thread through clone dir + alternates + policy dir + manifest + handoff/orphans); Task 10 Step 3 round-trip test |
| 10/11 — reserved dst | Task 3 tests + Task 4 `reservedContainerPaths` + integration tests in Task 9 |

**Placeholder scan:** no "TBD", "implement later", or "similar to" references. Every step has concrete code or commands.

**Type consistency:**
- `Mount.source: MountSource` introduced in Task 1 Step 1; consumed in Task 4 (`resolveMountCollisions`).
- `BuildMountsInput.repos[*].alternatesName` added in Task 1 Step 2; populated in Task 6 Step 1.
- `ResolveArtifactsInput.marketplaces` added in Task 8 Step 2; passed in Task 8 Step 4.
- `validateRepoRoOverlap(repos, ros, resolveRealpath)` signature introduced in Task 7 Step 1; consumed by tests in Task 7 Step 2.
- `resolveMountCollisions(mounts, { homeInContainer })` signature introduced in Task 4 Step 1; called in Task 9 Step 2.
- `filterSubsumedMarketplaces(marketplaces, repoHostPaths)` introduced in Task 2 Step 2; called in Task 8 Step 4.
- `alternatesName(basename, hostPath)` introduced in Task 5 Step 2; called in Task 6 Step 1.
- Hook/MCP `repos` input gains `alternatesName: string` in Task 6 Step 3; caller updated in Task 6 Step 4.

All signatures match across tasks.

**Policy consistency (review concern #1):**
- Marketplace subsumption is handled ONCE, in `filterSubsumedMarketplaces` (Task 2), before `resolveArtifacts` runs. The `resolveArtifacts.mark` loop only sees pre-filtered marketplaces, so the marketplace-equals-workspace-repo case cannot reach it — no contradiction with Task 8's hard-error-on-overlap rule.

**Scratch-path completeness (review concern #2 + round-2 follow-up):**
- `alternatesName` is threaded through FIVE locations:
  1. `$SESSION/repos/<alt>` — session clone directory (Task 6 Step 1).
  2. `/host-git-alternates/<alt>/…` — container alternates mount path (Task 6 Step 2).
  3. `$SESSION/policy/…/projects/<alt>/…` — hook/MCP policy scratch dir (Task 6 Step 3).
  4. `ManifestV1.repos[].alternates_name` — persisted so exit handoff can find the on-disk clone (Task 6 Steps 6-7).
  5. `handoff.ts` + `orphans.ts` path reconstruction via `alternates_name ?? basename` fallback (Task 6 Step 8).
- Without (4) and (5), renaming (1) would silently break handoff fetch-back and orphan commit counting — data loss in the same-basename case this plan is supposed to fix. Task 10 Step 3's extended verification exercises the round-trip.

**UX preservation (review concern #3):**
- `validateRepoRoOverlap` (Task 7 Step 1) wraps `realpath` with ENOENT-to-user-message translation. The test suite includes both a fake-realpath case and real-fs cases (Task 7 Step 2).

**Semantic trade-off (review concern #4):**
- Documented explicitly in the plan header ("Semantic trade-off acknowledged") and repeated in the warning text (Task 2 Step 2) and SPEC §"Plugin marketplace discovery" (Task 11 Step 3).

**Reserved-dst completeness (review concern #8):**
- `reservedContainerPaths` in Task 4 Step 1 includes the `homeInContainer`-based paths AND exposes a `prefixes` list for `/host-git-alternates/`. Test coverage in Task 3 Step 1 asserts all paths appear.
