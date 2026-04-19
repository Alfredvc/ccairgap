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

