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

