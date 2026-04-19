### Task 4: Rename `ts` → `id` in `orphans.ts` + `handoff.ts`

**Depends on:** Task 3
**Commit:** implementer
**Files:**
- Modify: `/Users/alfredvc/src/ccairgap/src/orphans.ts`
- Modify: `/Users/alfredvc/src/ccairgap/src/handoff.ts`

Internal rename. The `Orphan` type is not re-exported as a public API contract — `src/subcommands.ts:48` is the only consumer.

#### Steps:

- [ ] **Step 1: Edit `src/orphans.ts`**

Find:

```typescript
export interface Orphan {
  ts: string;
  sessionDir: string;
  repos: string[];
  commits: Record<string, number>;
}
```

Replace with:

```typescript
export interface Orphan {
  id: string;
  sessionDir: string;
  repos: string[];
  commits: Record<string, number>;
}
```

Find (the loop body):

```typescript
  for (const ts of readdirSync(dir)) {
    const sd = join(dir, ts);
    if (!statSync(sd).isDirectory()) continue;
    if (running.has(`ccairgap-${ts}`)) continue;

    let repos: string[] = [];
    const commits: Record<string, number> = {};
    try {
      const m = readManifest(sd, cliVer);
      repos = m.repos.map((r) => r.host_path);
      // Pre-existing sessions from old CLI builds that wrote branches as
      // `sandbox/<ts>` and omitted `branch` from the manifest — fall back so
      // commit counts still render for them.
      const branch = m.branch ?? `sandbox/${ts}`;
      for (const r of m.repos) {
        const sessionClone = join(sd, "repos", r.basename);
        if (existsSync(sessionClone)) {
          commits[r.basename] = await countCommitsAhead(
            sessionClone,
            branch,
            r.base_ref ?? "HEAD",
          );
        }
      }
    } catch {
      // unreadable manifest: still list as orphan
    }

    out.push({ ts, sessionDir: sd, repos, commits });
  }
```

Replace with:

```typescript
  for (const id of readdirSync(dir)) {
    const sd = join(dir, id);
    if (!statSync(sd).isDirectory()) continue;
    if (running.has(`ccairgap-${id}`)) continue;

    let repos: string[] = [];
    const commits: Record<string, number> = {};
    try {
      const m = readManifest(sd, cliVer);
      repos = m.repos.map((r) => r.host_path);
      // Pre-existing sessions from old CLI builds that wrote branches as
      // `sandbox/<ts>` and omitted `branch` from the manifest — fall back so
      // commit counts still render for them. Legacy dirs use a timestamp as
      // their `id`, so the substitution remains correct.
      const branch = m.branch ?? `sandbox/${id}`;
      for (const r of m.repos) {
        const sessionClone = join(sd, "repos", r.basename);
        if (existsSync(sessionClone)) {
          commits[r.basename] = await countCommitsAhead(
            sessionClone,
            branch,
            r.base_ref ?? "HEAD",
          );
        }
      }
    } catch {
      // unreadable manifest: still list as orphan
    }

    out.push({ id, sessionDir: sd, repos, commits });
  }
```

- [ ] **Step 2: Edit `src/handoff.ts`**

Find:

```typescript
export interface HandoffResult {
  sessionDir: string;
  ts: string;
  fetched: Array<{ hostPath: string; branch: string; status: FetchStatus }>;
  transcriptsCopied: number;
  removed: boolean;
  preserved: boolean;
  warnings: string[];
}
```

Replace with:

```typescript
export interface HandoffResult {
  sessionDir: string;
  id: string;
  fetched: Array<{ hostPath: string; branch: string; status: FetchStatus }>;
  transcriptsCopied: number;
  removed: boolean;
  preserved: boolean;
  warnings: string[];
}
```

Now rename every remaining `ts` occurrence inside the `handoff` function body (line 96 to end) to `id`. The occurrences are enumerated below — do each Edit individually to be safe, rather than a file-wide regex.

**Site 1** — local var declaration (line 96):
```typescript
  const ts = sessionDirPath.split("/").filter(Boolean).pop() ?? "<unknown>";
```
→
```typescript
  const id = sessionDirPath.split("/").filter(Boolean).pop() ?? "<unknown>";
```

**Sites 2a, 2b, 2c** — three early-return `HandoffResult` literals (lines ~105–115, ~122–130, ~133–141). Each looks like:
```typescript
    return {
      sessionDir: sessionDirPath,
      ts,
      fetched,
      transcriptsCopied,
      removed,
      preserved,
      warnings,
    };
```
In each, replace the line `      ts,` with `      id,`.

**Site 3** — legacy-branch fallback (line 147):
```typescript
  const branch = manifest.branch ?? `sandbox/${ts}`;
```
→
```typescript
  const branch = manifest.branch ?? `sandbox/${id}`;
```

**Site 4** — preserved-session warning inside `if (sandboxCount === 0)` (line 187):
```typescript
            `Drop when done: \`ccairgap discard ${ts}\`.`,
```
→
```typescript
            `Drop when done: \`ccairgap discard ${id}\`.`,
```

**Site 5** — sync copy-out target (line 204):
```typescript
    const outRoot = join(outputDir(), ts);
```
→
```typescript
    const outRoot = join(outputDir(), id);
```

**Site 6** — trailing `preserved` warning (line 244):
```typescript
      `session dir preserved at ${sessionDirPath}. Drop when done: \`ccairgap discard ${ts}\`.`,
```
→
```typescript
      `session dir preserved at ${sessionDirPath}. Drop when done: \`ccairgap discard ${id}\`.`,
```

**Site 7** — final return (line 259):
```typescript
  return {
    sessionDir: sessionDirPath,
    ts,
    fetched,
    transcriptsCopied,
    removed,
    preserved,
    warnings,
  };
```
Replace the `    ts,` line with `    id,`.

**Comment-only occurrences (lines 43, 145, 176, 201).** These are narrative prose inside jsdoc or inline comments that describe the legacy-branch fallback (`sandbox/<ts>`), the sandbox-empty case (`ccairgap/<ts>`), and the output layout (`$output/<ts>/<abs_src>/`). Leave them **untouched** for now — they describe on-disk contract from the external-SPEC point of view. Task 7 handles doc-level `<ts>` → `<id>` consistently, but these in-code comments are tied to the SPEC prose it rewrites; updating them together in Task 7 keeps the story coherent. (If you prefer, change them here; but do not change them with a regex — edit each explicitly so you can check the surrounding sentence still makes sense.)

After all edits, grep to confirm only the intended sites changed:

```bash
grep -n "\\bts\\b" src/handoff.ts
```
Expected: only matches in the four comments mentioned above. No matches in live code.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: `subcommands.ts` fails because it reads `o.id`, `result.id`, and takes `id` params (its own param is still `ts`). `launch.ts` Site 1 from Task 2 Step 7 also compiles now (`o.id` is valid). Fix the remaining `subcommands.ts` errors in Task 5.

---

