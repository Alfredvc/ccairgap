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

