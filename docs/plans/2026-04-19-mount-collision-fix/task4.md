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

