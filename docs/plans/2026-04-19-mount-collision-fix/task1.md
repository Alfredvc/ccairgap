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

