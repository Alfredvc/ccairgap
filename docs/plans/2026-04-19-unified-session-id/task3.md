### Task 3: Remove unused `compactTimestamp` from `paths.ts`

**Depends on:** Task 2
**Commit:** implementer
**Files:**
- Modify: `/Users/alfredvc/src/ccairgap/src/paths.ts`

After Task 2, `compactTimestamp` has no callers. Remove it. Also rename the `sessionDir` parameter `ts` → `id` for clarity; the parameter is the canonical session id now.

#### Steps:

- [ ] **Step 1: Verify no callers remain**

Run: `grep -rn "compactTimestamp" src/`
Expected: only the definition in `src/paths.ts`.

- [ ] **Step 2: Edit `src/paths.ts`**

Find:

```typescript
export function sessionDir(ts: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionsDir(env), ts);
}
```

Replace with:

```typescript
export function sessionDir(id: string, env?: NodeJS.ProcessEnv): string {
  return join(sessionsDir(env), id);
}
```

Find and delete (the whole function):

```typescript
/** ISO 8601 compact UTC timestamp, e.g. 20260417T143022Z. */
export function compactTimestamp(d: Date = new Date()): string {
  const iso = d.toISOString();
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: same set of errors as after Task 2 Step 8 — `handoff.ts`, `orphans.ts`, and `subcommands.ts` still pending renames. No new errors; removing `compactTimestamp` is safe because nothing references it anymore.

---

