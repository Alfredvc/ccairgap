### Task 2: Wire `generateId` into `launch.ts`

**Depends on:** Task 1
**Commit:** implementer
**Files:**
- Modify: `/Users/alfredvc/src/ccairgap/src/launch.ts`

Replaces the `compactTimestamp` call and the ad-hoc `--name` branch-collision check with a single `generateId` call. Renames `ts` → `id` throughout the file. Also renames `LaunchResult.ts` → `LaunchResult.id` (the field is read by `src/cli.ts`, updated in Task 5).

#### Steps:

- [ ] **Step 1: Replace imports**

Edit `src/launch.ts`. Find this block:

```typescript
import {
  compactTimestamp,
  hostClaudeDir,
  hostClaudeJson,
  outputDir as outputDirPath,
  realpath,
  sessionDir as sessionDirFn,
  sessionsDir as sessionsDirFn,
} from "./paths.js";
import { writeManifest, type Manifest } from "./manifest.js";
import {
  checkRefFormat,
  gitBranchExists,
  gitCheckoutNewBranch,
  gitCloneShared,
  readHostGitIdentity,
  resolveGitDir,
} from "./git.js";
```

Replace with:

```typescript
import {
  hostClaudeDir,
  hostClaudeJson,
  outputDir as outputDirPath,
  realpath,
  sessionDir as sessionDirFn,
  sessionsDir as sessionsDirFn,
} from "./paths.js";
import { writeManifest, type Manifest } from "./manifest.js";
import {
  gitCheckoutNewBranch,
  gitCloneShared,
  readHostGitIdentity,
  resolveGitDir,
} from "./git.js";
import { generateId, listAllContainerNames } from "./sessionId.js";
```

- [ ] **Step 2: Update the doc comment on `opts.name`**

Find:

```typescript
  /** If set, sandbox branch becomes `ccairgap/<name>` (instead of `ccairgap/<ts>`) and is forwarded to `claude -n <name>`. */
  name?: string;
```

Replace with:

```typescript
  /**
   * User-supplied prefix for the session id. If set, the final id becomes
   * `<name>-<4hex>`; otherwise a random `<adj>-<noun>-<4hex>` is generated.
   * The id drives the session dir, container name (`ccairgap-<id>`), branch
   * (`ccairgap/<id>`), and Claude's session label (`claude -n "ccairgap <id>"`,
   * rewritten to `[ccairgap] <id>` by the rename hook on first prompt).
   */
  name?: string;
```

- [ ] **Step 3: Rename `LaunchResult.ts` → `LaunchResult.id`**

Find:

```typescript
export interface LaunchResult {
  exitCode: number;
  ts: string;
  sessionDir: string;
  imageTag: string;
}
```

Replace with:

```typescript
export interface LaunchResult {
  exitCode: number;
  id: string;
  sessionDir: string;
  imageTag: string;
}
```

- [ ] **Step 4: Replace the `ts` derivation + branch-format check**

Find this block (around line 147–160):

```typescript
  // Compute ts + session dir paths up-front so we can resolve artifact
  // session-scratch targets before any filesystem side effects.
  const ts = compactTimestamp();
  const sessionPath = sessionDirFn(ts, env);

  // Branch name: `ccairgap/<name ?? ts>`. `<ts>` is always well-formed; a user-
  // supplied `<name>` is validated via `git check-ref-format` on the full ref.
  const branchSuffix = opts.name ?? ts;
  const branch = `ccairgap/${branchSuffix}`;
  if (opts.name !== undefined) {
    if (!(await checkRefFormat(`refs/heads/${branch}`))) {
      die(`--name "${opts.name}" is not a valid git ref component (branch would be ${branch})`);
    }
  }
```

Replace with a placeholder that introduces only the vars `id`, `sessionPath`, `branch` — we'll fill them in **after** the `repoPlans` loop so we can reuse `repoPlans[0].hostPath` (already realpath'd) instead of re-calling `realpath` on the raw input. For now:

```typescript
  // Session id is computed below after repoPlans is built — generateId reuses
  // the workspace repo's realpath result rather than re-running realpath here.
  let id: string;
  let sessionPath: string;
  let branch: string;
```

- [ ] **Step 5: Insert the `generateId` call after the `repoPlans` loop**

Scroll to the end of the `for (const hostPathRaw of opts.repos)` loop that builds `repoPlans` (around line 187). Immediately after that loop's closing brace, and before the `--ro paths must exist.` block, insert:

```typescript
  // Session id = `<prefix>-<4hex>`. Prefix is `opts.name` if set, else random
  // `<adj>-<noun>`. Retries on collision with an existing session dir, docker
  // container (running or stopped), or branch in the workspace repo.
  // repoPlans[0].hostPath is already realpath'd; reuse it so no extra syscall
  // and the ordering of error messages (missing-git-repo before docker probe)
  // stays the same as pre-rename.
  try {
    const gen = await generateId({
      userPrefix: opts.name,
      workspaceRepo: repoPlans[0]?.hostPath,
      runningContainers: await listAllContainerNames(),
      env,
    });
    id = gen.id;
  } catch (e) {
    die((e as Error).message);
  }
  sessionPath = sessionDirFn(id, env);
  branch = `ccairgap/${id}`;
```

**Important:** the `repoPlans` loop body uses `join(sessionPath, "repos", bn)` to construct `sessionClonePath`. `sessionPath` is not yet defined when the loop runs, so this breaks. Fix: **do not** include `sessionClonePath` in the initial `repoPlans` construction. Instead:

Find the loop body (around line 170–187):

```typescript
  const repoPlans: RepoPlan[] = [];
  for (const hostPathRaw of opts.repos) {
    const hostPath = realpath(hostPathRaw);
    let realGitDir: string;
    try {
      realGitDir = resolveGitDir(hostPath);
    } catch (e) {
      die((e as Error).message);
    }
    const bn = basename(hostPath);
    repoPlans.push({
      basename: bn,
      hostPath,
      realGitDir,
      sessionClonePath: join(sessionPath, "repos", bn),
      baseRef: opts.base,
    });
  }
```

Replace with a two-phase construction that fills `sessionClonePath` only once `sessionPath` is known:

```typescript
  // Phase 1: resolve each repo's git dir. `sessionClonePath` is filled in
  // after `id` is generated below, because it depends on the session dir.
  type PendingRepo = {
    basename: string;
    hostPath: string;
    realGitDir: string;
    baseRef?: string;
  };
  const pendingRepos: PendingRepo[] = [];
  for (const hostPathRaw of opts.repos) {
    const hostPath = realpath(hostPathRaw);
    let realGitDir: string;
    try {
      realGitDir = resolveGitDir(hostPath);
    } catch (e) {
      die((e as Error).message);
    }
    pendingRepos.push({
      basename: basename(hostPath),
      hostPath,
      realGitDir,
      baseRef: opts.base,
    });
  }
```

Then, **after** the `generateId` call from the previous step, add:

```typescript
  // Phase 2: attach session clone paths now that `id` (and so `sessionPath`) exists.
  type RepoPlan = PendingRepo & { sessionClonePath: string };
  const repoPlans: RepoPlan[] = pendingRepos.map((r) => ({
    ...r,
    sessionClonePath: join(sessionPath, "repos", r.basename),
  }));
```

Keep the original local `type RepoPlan = { basename: string; hostPath: string; realGitDir: string; sessionClonePath: string; baseRef?: string; };` declaration deleted — it's replaced by the intersection type above. Any downstream references to `repoPlans` or the `RepoPlan` type are unchanged because the new type has the same shape.

- [ ] **Step 6: Remove the redundant `gitBranchExists` check**

Find (the block added only for `--name`, now covered by `generateId`):

```typescript
  // Branch-collision check (only meaningful when --name is passed; `ccairgap/<ts>`
  // is always unique). Check only the workspace repo (repoPlans[0]); extra repos
  // ride along and are left to surface their own collision at fetch time if any.
  if (opts.name !== undefined && repoPlans.length > 0) {
    const workspace = repoPlans[0]!;
    if (await gitBranchExists(workspace.hostPath, branch)) {
      die(
        `branch ${branch} already exists in ${workspace.hostPath}. ` +
          `Pick a different --name or delete the existing branch.`,
      );
    }
  }

  // Resolve cp/sync/mount: validate, detect overlaps, plan copies & mounts.
```

Replace with:

```typescript
  // Resolve cp/sync/mount: validate, detect overlaps, plan copies & mounts.
```

- [ ] **Step 7: Replace remaining `ts` references in `launch.ts`**

These five sites still use `ts`:

**Site 1** — orphan-scan banner (around line 237–240):
```typescript
  if (orphans.length > 0) {
    console.error("ccairgap: orphaned sessions detected:");
    for (const o of orphans) {
      console.error(`  ${o.ts}  repos=${o.repos.join(",") || "(none)"}`);
    }
    console.error("  Recover: ccairgap recover <ts>");
    console.error("  Discard: ccairgap discard <ts>");
    console.error("");
  }
```
Change to:
```typescript
  if (orphans.length > 0) {
    console.error("ccairgap: orphaned sessions detected:");
    for (const o of orphans) {
      console.error(`  ${o.id}  repos=${o.repos.join(",") || "(none)"}`);
    }
    console.error("  Recover: ccairgap recover <id>");
    console.error("  Discard: ccairgap discard <id>");
    console.error("");
  }
```
(`o.id` is the renamed field — see Task 4. If you run typecheck after this task, the field rename is not yet in place and this line will not yet compile. That is intentional; the batched commit happens at Task 5.)

**Site 2** — container name (around line 412):
```typescript
  dockerArgs.push("--cap-drop=ALL", "--security-opt=no-new-privileges", "--name", `ccairgap-${ts}`);
```
Change to:
```typescript
  dockerArgs.push("--cap-drop=ALL", "--security-opt=no-new-privileges", "--name", `ccairgap-${id}`);
```

**Site 3** — env var passed to entrypoint (around line 422) — the whole purpose of the env var is now the id, always set:
```typescript
  if (opts.name !== undefined) {
    dockerArgs.push("-e", `CCAIRGAP_NAME=${opts.name}`);
  }
```
Change to:
```typescript
  // CCAIRGAP_NAME carries the session id to the entrypoint, which uses it for
  // `claude -n "ccairgap <id>"` and the rename-hook sessionTitle `[ccairgap] <id>`.
  dockerArgs.push("-e", `CCAIRGAP_NAME=${id}`);
```

**Site 4** — handoff-failure hint (around line 455):
```typescript
      console.error(`  Recover manually: ccairgap recover ${ts}`);
```
Change to:
```typescript
      console.error(`  Recover manually: ccairgap recover ${id}`);
```

**Site 5** — return value (around line 459):
```typescript
  return { exitCode, ts, sessionDir: sessionPath, imageTag: image.tag };
```
Change to:
```typescript
  return { exitCode, id, sessionDir: sessionPath, imageTag: image.tag };
```

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: compile errors in `handoff.ts`, `orphans.ts`, and `subcommands.ts` (field/param rename is pending). `cli.ts` does **not** read `result.ts` or `result.id`, so no new `cli.ts` errors surface here. If any other files fail unexpectedly, stop and investigate before continuing.

- [ ] **Step 9: Hold the commit**

Do not commit yet. The rename of `LaunchResult.id` has no `cli.ts` consumer (it's unused), and the remaining compile errors in `handoff.ts`/`orphans.ts`/`subcommands.ts` are resolved in Tasks 4 and 5. The batched commit for Tasks 2–5 happens at the end of Task 5.

---

