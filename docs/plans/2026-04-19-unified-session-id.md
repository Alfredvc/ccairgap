# Unified Session Identifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use agentfiles:subagent-driven-development (recommended) or agentfiles:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the timestamp-based session identifier (`<ts>` = `20260419T143022Z`) with a readable `<prefix>-<4hex>` id that is the single canonical name for session dir, docker container, sandbox branch, and Claude session label.

**Architecture:** A new `src/sessionId.ts` module generates ids. The prefix is either user-supplied (`--name`) or a random cute `<adj>-<noun>` from a bundled word list. A 4-hex suffix is always appended. The generator retries up to 8× on collision with an existing session dir, container (running or stopped), or branch. The id replaces all uses of `ts` as an opaque identifier — dir names, container names, branches, the `-n` label to Claude, and the handoff/orphan/recover subcommand arguments. Existing timestamp-named session dirs still work because ids are treated opaquely throughout.

**Tech Stack:** TypeScript ESM · Node ≥ 20 · vitest · execa · commander. No new runtime dependencies.

---

## Context for the Implementer

Read before you start — the project has strict invariants.

- **Project CLAUDE.md** (`/Users/alfredvc/src/ccairgap/CLAUDE.md`) — stack, layout, non-obvious invariants, SPEC-first rule.
- **docs/SPEC.md** — authoritative design. Session id and branch naming are user-facing; do not diverge from this plan without updating SPEC.
- **README.md** — user-facing flag reference and the two-step rename narrative (`README.md:144`).

Key conventions:
1. Update `docs/SPEC.md` *first* when behavior changes. README second. Inline code third.
2. No new runtime deps.
3. `src/*.test.ts` colocated with implementation. `npm test` runs vitest.
4. `tsc --noEmit` must pass before commit.

### Current-state cheat sheet

The existing code uses `ts` (ISO compact timestamp) as the opaque session identifier. Three key uses:

1. **Session dir** — `$STATE/sessions/<ts>` (`src/paths.ts:23` `sessionDir(ts, env)`).
2. **Container name** — `ccairgap-<ts>` (`src/launch.ts:412`).
3. **Branch** — `ccairgap/<ts>`, or `ccairgap/<--name>` when user passed `--name` (`src/launch.ts:154`).

Three lookups treat the dir name as opaque already:
- `src/orphans.ts:32` — `readdirSync(sessionsDir())` yields dir names straight through.
- `src/subcommands.ts:52` `recover(ts?)` / `:70` `discard(ts)` — `ts` is just the dir-name arg.
- `src/handoff.ts:96` — `sessionDirPath.split("/").filter(Boolean).pop()` to echo in logs.

These lookups keep working for old timestamp-named dirs because they never parse `ts` as a timestamp — it's an opaque string. Good.

### What each task produces

| File | Create / Modify | Responsibility |
|------|-----------------|----------------|
| `src/sessionId.ts` | Create | Word lists + `generateId()` + `listAllContainerNames()` |
| `src/sessionId.test.ts` | Create | Unit tests for word-list format, hex suffix, collision retry |
| `src/launch.ts` | Modify | Call `generateId`; drop `compactTimestamp` + per-`--name` branch check |
| `src/paths.ts` | Modify | Remove unused `compactTimestamp` |
| `src/orphans.ts` | Modify | Rename `Orphan.ts` → `Orphan.id` (internal type) |
| `src/handoff.ts` | Modify | Rename local `ts` → `id` |
| `src/subcommands.ts` | Modify | Rename `recover(ts?)`/`discard(ts)` params → `id` |
| `src/cli.ts` | Modify | Rename positional args; update `--name` help text |
| `docker/entrypoint.sh` | Modify | `-n "ccairgap $CCAIRGAP_NAME"` (was `-n "$CCAIRGAP_NAME"`) |
| `docs/SPEC.md` | Modify | Replace `<ts>` with `<id>`; add §"Session identifier" |
| `README.md` | Modify | Replace `<ts>` with `<id>`; update `-n/--name` table row |
| `CLAUDE.md` | Modify | Update "Non-obvious invariants" bullets that reference `<ts>` |
| `skills/ccairgap-configure/references/*.md` | Modify | Replace `<ts>` in config-schema.md, docker-run-args.md, artifact-decision.md |

---

### Task 1: Create `src/sessionId.ts` with generator + unit tests

**Commit:** implementer
**Files:**
- Create: `/Users/alfredvc/src/ccairgap/src/sessionId.ts`
- Test: `/Users/alfredvc/src/ccairgap/src/sessionId.test.ts`

This is the foundation. Test first, implementation second.

#### Steps:

- [ ] **Step 1: Write the failing tests**

Create `/Users/alfredvc/src/ccairgap/src/sessionId.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateId,
  randomPrefix,
  MAX_ATTEMPTS,
  __wordPoolsForTest,
} from "./sessionId.js";

describe("randomPrefix", () => {
  it("returns `<adj>-<noun>` with words from the bundled pools", () => {
    const { adjectives, nouns } = __wordPoolsForTest();
    const p = randomPrefix();
    const parts = p.split("-");
    expect(parts).toHaveLength(2);
    expect(adjectives).toContain(parts[0]);
    expect(nouns).toContain(parts[1]);
  });

  it("uses only lowercase ASCII letters", () => {
    for (let i = 0; i < 50; i++) {
      expect(randomPrefix()).toMatch(/^[a-z]+-[a-z]+$/);
    }
  });
});

describe("generateId", () => {
  function makeEnv() {
    const root = mkdtempSync(join(tmpdir(), "ccairgap-sessionid-"));
    return {
      env: { CCAIRGAP_HOME: root } as NodeJS.ProcessEnv,
      cleanup: () => rmSync(root, { recursive: true, force: true }),
      sessionsDir: join(root, "sessions"),
    };
  }

  /** Deterministic hex source factory for retry tests. */
  function fixedHexes(hexes: string[]): () => string {
    let i = 0;
    return () => {
      const h = hexes[i++];
      if (h === undefined) throw new Error("fixedHexes exhausted");
      return h;
    };
  }

  it("returns `<prefix>-<4hex>` when no user prefix given", async () => {
    const h = makeEnv();
    try {
      const r = await generateId({
        runningContainers: new Set(),
        env: h.env,
      });
      expect(r.id).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{4}$/);
      expect(r.prefix).toMatch(/^[a-z]+-[a-z]+$/);
      expect(r.id.startsWith(r.prefix + "-")).toBe(true);
      expect(r.attempts).toBe(1);
    } finally {
      h.cleanup();
    }
  });

  it("uses the user-supplied prefix verbatim and always appends hex", async () => {
    const h = makeEnv();
    try {
      const r = await generateId({
        userPrefix: "my-feature",
        runningContainers: new Set(),
        env: h.env,
      });
      expect(r.prefix).toBe("my-feature");
      expect(r.id).toMatch(/^my-feature-[0-9a-f]{4}$/);
    } finally {
      h.cleanup();
    }
  });

  it("retries when the session dir for the generated id already exists", async () => {
    const h = makeEnv();
    try {
      mkdirSync(h.sessionsDir, { recursive: true });
      mkdirSync(join(h.sessionsDir, "prefix-0001"), { recursive: true });
      mkdirSync(join(h.sessionsDir, "prefix-0002"), { recursive: true });
      const r = await generateId({
        userPrefix: "prefix",
        runningContainers: new Set(),
        env: h.env,
        hexSource: fixedHexes(["0001", "0002", "0003"]),
      });
      expect(r.id).toBe("prefix-0003");
      expect(r.attempts).toBe(3);
    } finally {
      h.cleanup();
    }
  });

  it("skips ids whose container name is in the running set", async () => {
    const h = makeEnv();
    try {
      const r = await generateId({
        userPrefix: "pinned",
        runningContainers: new Set(["ccairgap-pinned-00aa"]),
        env: h.env,
        hexSource: fixedHexes(["00aa", "00bb"]),
      });
      expect(r.id).toBe("pinned-00bb");
      expect(r.attempts).toBe(2);
    } finally {
      h.cleanup();
    }
  });

  it("errors after MAX_ATTEMPTS if every attempt collides", async () => {
    const h = makeEnv();
    try {
      mkdirSync(h.sessionsDir, { recursive: true });
      const hexes: string[] = [];
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        const hex = i.toString(16).padStart(4, "0");
        hexes.push(hex);
        mkdirSync(join(h.sessionsDir, `prefix-${hex}`), { recursive: true });
      }
      await expect(
        generateId({
          userPrefix: "prefix",
          runningContainers: new Set(),
          env: h.env,
          hexSource: fixedHexes(hexes),
        }),
      ).rejects.toThrow(/failed to find a free session id/);
    } finally {
      h.cleanup();
    }
  });

  it("rejects a user --name prefix that is not a valid git ref", async () => {
    const h = makeEnv();
    try {
      await expect(
        generateId({
          userPrefix: "has spaces",
          runningContainers: new Set(),
          env: h.env,
        }),
      ).rejects.toThrow(/not a valid git ref/);
    } finally {
      h.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- sessionId`
Expected: FAIL — `sessionId` module does not exist.

- [ ] **Step 3: Write `src/sessionId.ts`**

Create `/Users/alfredvc/src/ccairgap/src/sessionId.ts`:

```typescript
import { existsSync } from "node:fs";
import { randomBytes, randomInt } from "node:crypto";
import { execa } from "execa";
import { sessionDir as sessionDirFn } from "./paths.js";
import { checkRefFormat, gitBranchExists } from "./git.js";

/**
 * Cute adjective/noun word pools. All lowercase `[a-z]+`, safe for git refs
 * and docker container names without escaping. Collision avoidance is carried
 * by the always-appended 4-hex suffix (65536 combos per fixed prefix); with a
 * random prefix the combined space is ~9k × 64k ≈ 6×10^8.
 *
 * Word pools are an implementation detail and may grow or shuffle across
 * releases without a major-version bump. If you script against generated ids,
 * match on the shape `[a-z0-9-]+-[0-9a-f]{4}$`, not on specific words.
 */
const ADJECTIVES: readonly string[] = [
  "fuzzy", "happy", "sleepy", "bouncy", "cheery", "cozy", "dandy", "eager",
  "fluffy", "gentle", "giddy", "jolly", "merry", "mossy", "nimble", "peppy",
  "plucky", "snug", "sunny", "tender", "witty", "zesty", "bubbly", "calm",
  "cuddly", "daring", "dizzy", "dreamy", "earnest", "fancy", "feisty", "frisky",
  "gleeful", "glowing", "honeyed", "jaunty", "jumpy", "kindly", "lively", "lucky",
  "mellow", "minty", "misty", "nifty", "perky", "posh", "quirky", "ruddy",
  "rustic", "sassy", "silky", "spiffy", "spry", "squishy", "tidy", "tiny",
  "twinkly", "velvety", "waggy", "whimsy", "wiggly", "wispy", "zany", "brave",
  "brisk", "chipper", "chummy", "dainty", "doughy", "fleecy", "frosty", "grumpy",
  "hazy", "hushed", "inky", "jazzy", "lanky", "leafy", "lofty", "loopy",
  "moony", "nippy", "noble", "peachy", "plushy", "puffy", "purring", "quiet",
  "radiant", "roomy", "salty", "scruffy", "sleek", "snappy", "snazzy", "snoozy",
];

const NOUNS: readonly string[] = [
  "otter", "panda", "pebble", "puffin", "quokka", "squirrel", "wombat", "badger",
  "biscuit", "cloud", "daisy", "dumpling", "ferret", "finch", "gecko", "hedgehog",
  "lemur", "mango", "marmot", "muffin", "noodle", "owl", "penguin", "pumpkin",
  "raccoon", "seal", "sparrow", "tadpole", "teacup", "walrus", "acorn", "basil",
  "beagle", "bramble", "bunny", "chestnut", "chipmunk", "clover", "cocoa", "cub",
  "dolphin", "duckling", "eel", "fawn", "fern", "fig", "frog", "goose",
  "grape", "guppy", "hamster", "heron", "honey", "iguana", "jellybean", "kitten",
  "koala", "lark", "lemon", "lizard", "llama", "lobster", "lotus", "lynx",
  "magpie", "manta", "meerkat", "melon", "mole", "moth", "newt", "oatcake",
  "octopus", "olive", "opal", "orca", "parsnip", "peach", "petal", "pigeon",
  "pinecone", "platypus", "plum", "pug", "puppy", "quail", "radish", "raven",
  "rhino", "robin", "sloth", "snail", "sprout", "starfish", "swan", "tamarin",
];

/** Test-only export so the unit test can assert pool membership. */
export function __wordPoolsForTest(): { adjectives: readonly string[]; nouns: readonly string[] } {
  return { adjectives: ADJECTIVES, nouns: NOUNS };
}

function pick<T>(arr: readonly T[]): T {
  return arr[randomInt(0, arr.length)]!;
}

/** 4 lowercase hex chars. 65536 combos per prefix. */
function hex4(): string {
  return randomBytes(2).toString("hex");
}

/** Random `<adj>-<noun>` pair. */
export function randomPrefix(): string {
  return `${pick(ADJECTIVES)}-${pick(NOUNS)}`;
}

export interface IdGenInput {
  /** User-supplied `--name`; becomes the id prefix verbatim. */
  userPrefix?: string;
  /** Workspace repo for branch-collision check. Undefined → skip branch check. */
  workspaceRepo?: string;
  /** Container names to avoid (running + stopped). Pre-fetched by caller. */
  runningContainers: Set<string>;
  env?: NodeJS.ProcessEnv;
  /**
   * Deterministic hex source for unit tests. Default: `crypto.randomBytes(2).toString("hex")`.
   * Production callers never pass this.
   */
  hexSource?: () => string;
}

export interface IdGenResult {
  id: string;
  prefix: string;
  /** Attempts taken (1-based). */
  attempts: number;
}

export const MAX_ATTEMPTS = 8;

/**
 * Generate a session id of the form `<prefix>-<4hex>`. Retries on collision
 * with an existing session dir, running-or-stopped container, or branch.
 * Hex suffix is always appended; user-supplied prefix is never stripped.
 * Errors after MAX_ATTEMPTS retries.
 *
 * Branch-ref format is validated once on the first attempt — invariant across
 * hex suffixes, so there's no point re-validating per attempt.
 */
export async function generateId(input: IdGenInput): Promise<IdGenResult> {
  const prefix = input.userPrefix ?? randomPrefix();
  const hexFn = input.hexSource ?? hex4;
  let refFormatChecked = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const id = `${prefix}-${hexFn()}`;
    const branch = `ccairgap/${id}`;
    const container = `ccairgap-${id}`;

    if (!refFormatChecked) {
      if (!(await checkRefFormat(`refs/heads/${branch}`))) {
        throw new Error(
          `--name "${prefix}" is not a valid git ref component (branch would be ccairgap/${prefix}-<hex>)`,
        );
      }
      refFormatChecked = true;
    }

    if (existsSync(sessionDirFn(id, input.env))) continue;
    if (input.runningContainers.has(container)) continue;
    if (input.workspaceRepo && (await gitBranchExists(input.workspaceRepo, branch))) continue;

    return { id, prefix, attempts: attempt };
  }

  throw new Error(
    `failed to find a free session id with prefix "${prefix}" after ${MAX_ATTEMPTS} attempts. ` +
      `Pick a different --name, or clean up stale sessions/containers/branches.`,
  );
}

/**
 * Snapshot of running + stopped container names. Passed into `generateId` so
 * retries don't reshell `docker ps` each loop.
 *
 * Returns an empty set on any docker error (daemon down, docker missing, etc.).
 * The real collision detection comes from `docker run --name ccairgap-<id>`
 * later in the launch pipeline, which fails loudly with "name already in use".
 * An empty set here only means id collision avoidance is best-effort, not
 * authoritative — it does not mask errors.
 *
 * Note: this is a snapshot, not a reservation. Two concurrent `ccairgap`
 * invocations could in principle generate the same id (probability
 * 1/65536 per shared prefix). The second `docker run` fails cleanly;
 * blast radius is one orphaned session dir that `ccairgap discard` clears.
 */
export async function listAllContainerNames(): Promise<Set<string>> {
  try {
    const { stdout } = await execa("docker", ["ps", "-a", "--format", "{{.Names}}"]);
    return new Set(stdout.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- sessionId`
Expected: PASS, 8 tests (2 for `randomPrefix`, 6 for `generateId`).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/sessionId.ts src/sessionId.test.ts
git commit -m "feat(sessionId): add readable session id generator

Introduces <prefix>-<4hex> ids backed by bundled adjective/noun pools.
Caller supplies known container names; generator retries on collision
with existing session dir, container name, or branch."
```

---

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

### Task 5: Rename `ts` → `id` in `subcommands.ts` + `cli.ts`

**Depends on:** Task 4
**Commit:** implementer
**Files:**
- Modify: `/Users/alfredvc/src/ccairgap/src/subcommands.ts`
- Modify: `/Users/alfredvc/src/ccairgap/src/cli.ts`

Finishes the rename. `cli.ts` also gets the updated `--name` help text and the renamed positional args on the `recover`/`discard` commands.

#### Steps:

- [ ] **Step 1: Edit `src/subcommands.ts`**

Find:

```typescript
  for (const o of orphans) {
    const commits = Object.entries(o.commits)
      .map(([k, v]) => `${k}+${v}`)
      .join(" ");
    console.log(`${o.ts}  repos=${o.repos.join(",") || "(none)"}  ${commits}`);
  }
```

Replace with:

```typescript
  for (const o of orphans) {
    const commits = Object.entries(o.commits)
      .map(([k, v]) => `${k}+${v}`)
      .join(" ");
    console.log(`${o.id}  repos=${o.repos.join(",") || "(none)"}  ${commits}`);
  }
```

Find:

```typescript
export async function recover(ts?: string): Promise<void> {
  if (!ts) return listOrphans();
  const sd = sessionDirFn(ts);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  const result = await handoff(sd, cliVersion());
  const counts = { fetched: 0, empty: 0, failed: 0 };
  for (const f of result.fetched) counts[f.status]++;
  console.log(
    `recovered ${ts}: ${counts.fetched} fetched, ${counts.empty} empty, ${counts.failed} failed, ` +
      `${result.transcriptsCopied} transcript dirs copied, ` +
      `session dir ${result.removed ? "removed" : result.preserved ? "preserved" : "kept"}`,
  );
  if (result.warnings.length > 0) process.exitCode = 1;
}

export function discard(ts: string): void {
  const sd = sessionDirFn(ts);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  rmSync(sd, { recursive: true, force: true });
  console.log(`discarded ${ts}`);
}
```

Replace with:

```typescript
export async function recover(id?: string): Promise<void> {
  if (!id) return listOrphans();
  const sd = sessionDirFn(id);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  const result = await handoff(sd, cliVersion());
  const counts = { fetched: 0, empty: 0, failed: 0 };
  for (const f of result.fetched) counts[f.status]++;
  console.log(
    `recovered ${id}: ${counts.fetched} fetched, ${counts.empty} empty, ${counts.failed} failed, ` +
      `${result.transcriptsCopied} transcript dirs copied, ` +
      `session dir ${result.removed ? "removed" : result.preserved ? "preserved" : "kept"}`,
  );
  if (result.warnings.length > 0) process.exitCode = 1;
}

export function discard(id: string): void {
  const sd = sessionDirFn(id);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  rmSync(sd, { recursive: true, force: true });
  console.log(`discarded ${id}`);
}
```

- [ ] **Step 2: Edit `src/cli.ts` — `--name` help text**

Find:

```typescript
    .option(
      "-n, --name <name>",
      "session name. Used as branch suffix (`ccairgap/<name>`) and forwarded to `claude -n \"[ccairgap] <name>\"` so the session shows up with that label in `/resume` and the terminal title. The `[ccairgap]` prefix is always applied. Must be a valid git ref component; aborts on collision with an existing branch in --repo.",
    )
```

Replace with:

```typescript
    .option(
      "-n, --name <name>",
      "session id prefix. Used as-is; the CLI appends a 4-hex suffix so the final id is `<name>-<4hex>`. The id drives the session dir, docker container (`ccairgap-<id>`), branch (`ccairgap/<id>`), and Claude's session label (`[ccairgap] <id>`). If omitted, a random `<adj>-<noun>` prefix is generated. Must be a valid git ref component.",
    )
```

Find:

```typescript
    .option("--base <ref>", "base ref for ccairgap/<ts> branch (default: HEAD)")
```

Replace with:

```typescript
    .option("--base <ref>", "base ref for ccairgap/<id> branch (default: HEAD)")
```

Find:

```typescript
    .option(
      "--sync <path>",
      "like --cp, but on exit the container-written copy is mirrored to $CCAIRGAP_HOME/output/<ts>/<abs-src>/. Repeatable.",
      collect,
      [],
    )
```

Replace with:

```typescript
    .option(
      "--sync <path>",
      "like --cp, but on exit the container-written copy is mirrored to $CCAIRGAP_HOME/output/<id>/<abs-src>/. Repeatable.",
      collect,
      [],
    )
```

- [ ] **Step 3: Edit `src/cli.ts` — `recover` / `discard` subcommands**

Find:

```typescript
  program
    .command("recover [ts]")
    .description("run handoff for a session (idempotent); without <ts>, same as list")
    .action(async (ts?: string) => {
      await recover(ts);
    });

  program
    .command("discard <ts>")
    .description("delete a session dir without running handoff")
    .action((ts: string) => {
      discard(ts);
    });
```

Replace with:

```typescript
  program
    .command("recover [id]")
    .description("run handoff for a session (idempotent); without <id>, same as list")
    .action(async (id?: string) => {
      await recover(id);
    });

  program
    .command("discard <id>")
    .description("delete a session dir without running handoff")
    .action((id: string) => {
      discard(id);
    });
```

- [ ] **Step 4: Typecheck + test**

Run: `npm run typecheck && npm test`
Expected: both pass with zero errors.

- [ ] **Step 5: Commit (covers Tasks 2–5)**

```bash
git add src/launch.ts src/paths.ts src/orphans.ts src/handoff.ts src/subcommands.ts src/cli.ts
git commit -m "refactor: unify session identifier as <prefix>-<4hex>

Replaces the ISO-timestamp ts throughout the launch pipeline, handoff,
recover, discard, list, and orphan scan with a single readable session id
generated from generateId(). --name becomes the prefix; the 4-hex suffix
is always appended. Existing timestamp-named session dirs continue to
work because ids are treated as opaque strings."
```

---

### Task 6: Update `docker/entrypoint.sh`

**Depends on:** Task 5
**Commit:** implementer
**Files:**
- Modify: `/Users/alfredvc/src/ccairgap/docker/entrypoint.sh`

`CCAIRGAP_NAME` is now always the session id. The initial `claude -n` label becomes `"ccairgap <id>"` (prefix "ccairgap " first — per user decision), the rename-hook rewrite stays `"[ccairgap] $CCAIRGAP_NAME"`. Because the two strings still differ, Claude's hook-dedup still fires and the TUI rename still paints.

Keep the `-n "ccairgap"` branch as a belt-and-suspenders fallback when `CCAIRGAP_NAME` is unset — the CLI always sets it now, but the entrypoint can still be launched directly by a user poking at the image.

#### Steps:

- [ ] **Step 1: Edit `docker/entrypoint.sh`**

Find (around line 127–138):

```bash
# Session name → `claude -n <name>` (seeds /resume label + terminal title).
# Intentionally differs from the UserPromptSubmit hook's sessionTitle output:
# the hook applies "[ccairgap]" / "[ccairgap] $CCAIRGAP_NAME" on first prompt,
# which renames the session and paints the TUI's TextInput border. If `-n` and
# the hook emitted the same string, Claude's hook dedup (Ma8) would skip the
# rename and the border recolor would never fire.
if [ -n "${CCAIRGAP_NAME:-}" ]; then
    NAME_ARGS=(-n "$CCAIRGAP_NAME")
else
    NAME_ARGS=(-n "ccairgap")
fi
```

Replace with:

```bash
# Session label → `claude -n "ccairgap <id>"` (seeds /resume label + terminal
# title). Intentionally differs from the UserPromptSubmit hook's sessionTitle
# output "[ccairgap] <id>": if the two strings matched, Claude's hook dedup
# would skip the rename and the TUI TextInput border would never recolor.
# CCAIRGAP_NAME carries the full session id from the CLI; the fallback branch
# only runs when the entrypoint is executed directly without the CLI env.
if [ -n "${CCAIRGAP_NAME:-}" ]; then
    NAME_ARGS=(-n "ccairgap $CCAIRGAP_NAME")
else
    NAME_ARGS=(-n "ccairgap")
fi
```

Also update the sessionTitle hook (around lines 91–98) — it already reads `CCAIRGAP_NAME` and emits `[ccairgap] $CCAIRGAP_NAME`. No change needed there. Verify the block currently reads:

```bash
TITLE_HOOK="/tmp/ccairgap-session-title.sh"
cat > "$TITLE_HOOK" << 'HOOK_EOF'
#!/bin/sh
TITLE="${CCAIRGAP_NAME:+[ccairgap] $CCAIRGAP_NAME}"
TITLE="${TITLE:-[ccairgap]}"
printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","sessionTitle":"%s"}}\n' "$TITLE"
HOOK_EOF
chmod +x "$TITLE_HOOK"
```

Leave this untouched.

- [ ] **Step 2: Shellcheck**

Run: `shellcheck docker/entrypoint.sh`
Expected: no new warnings vs. pre-change (run once on current HEAD first to establish baseline if unsure).

- [ ] **Step 3: Commit**

```bash
git add docker/entrypoint.sh
git commit -m "refactor(entrypoint): use 'ccairgap <id>' as initial claude -n label

The two-step rename still works: '-n \"ccairgap <id>\"' initially,
then the UserPromptSubmit hook rewrites to '[ccairgap] <id>' on first
prompt. CCAIRGAP_NAME now carries the full session id from the CLI."
```

---

### Task 7: Update `docs/SPEC.md`, `README.md`, `CLAUDE.md`, and skill references

**Depends on:** Task 6
**Commit:** implementer
**Files:**
- Modify: `/Users/alfredvc/src/ccairgap/docs/SPEC.md`
- Modify: `/Users/alfredvc/src/ccairgap/README.md`
- Modify: `/Users/alfredvc/src/ccairgap/CLAUDE.md`
- Modify: `/Users/alfredvc/src/ccairgap/SECURITY.md`
- Modify: `/Users/alfredvc/src/ccairgap/skills/ccairgap-configure/references/config-schema.md`
- Modify: `/Users/alfredvc/src/ccairgap/skills/ccairgap-configure/references/docker-run-args.md`
- Modify: `/Users/alfredvc/src/ccairgap/skills/ccairgap-configure/references/artifact-decision.md`

SPEC first (per project convention), then README, then inline docs.

#### Steps:

- [ ] **Step 1: Add "Session identifier" section to SPEC**

Open `docs/SPEC.md`. Find the section around line 54 that currently reads:

```markdown
- `<ts>` is ISO 8601 compact, e.g. `20260417T143022Z`.
```

Replace with:

```markdown
- `<id>` is the session identifier. Generated as `<prefix>-<4hex>` where:
  - **prefix** is `--name <name>` if the user passed one, otherwise a random
    `<adj>-<noun>` pair drawn from the bundled word list in `src/sessionId.ts`.
  - **4hex** is always appended (via `crypto.randomBytes`) so collisions are
    rare even for fixed prefixes (65536 combos per prefix).
- The id drives four things uniformly: session dir (`$XDG_STATE_HOME/ccairgap/sessions/<id>`),
  docker container (`ccairgap-<id>`), sandbox branch (`ccairgap/<id>`), and
  Claude's session label (`-n "ccairgap <id>"`, rewritten to `[ccairgap] <id>`
  by the rename hook on first prompt).
- On collision with any of session dir / running-or-stopped container / workspace
  branch, the hex suffix is re-rolled up to 8 times before aborting.
- Validated once via `git check-ref-format refs/heads/ccairgap/<id>`; a bad
  `--name` surfaces before any filesystem side effects.
```

- [ ] **Step 2: Replace `<ts>` with `<id>` throughout SPEC (mechanical substitution)**

Use the Edit tool with `replace_all: true` on `docs/SPEC.md` to replace the literal string `<ts>` with `<id>`. This is safe because `<ts>` is never used to mean "timestamp example" in SPEC — the one explicit timestamp example (`20260417T143022Z`) appears without the angle-bracket placeholder and is replaced separately by Step 1 above.

After the replace, grep to confirm zero `<ts>` remain:

```bash
grep -n "<ts>" docs/SPEC.md
```
Expected: no output.

- [ ] **Step 3: SPEC prose rewrites (semantic, not mechanical)**

Three SPEC passages describe the **mechanics** of branch naming, the `-n` flag, and the `CCAIRGAP_NAME` env var. After the mechanical substitution in Step 2, these now say `<id>` but the surrounding prose still describes the old two-flag model (`ts` default vs. `--name` override). Rewrite each in place.

**Passage 1** — §"Launch sequence" step 7 (around `docs/SPEC.md:155`). Find:

```markdown
   - `<branch>` is `ccairgap/<id>` by default, or `ccairgap/<--name>` when `--name` was passed. The name is validated (`git check-ref-format refs/heads/<branch>`) and checked for collision on the workspace repo (`--repo`) before side effects.
```

Replace with:

```markdown
   - `<branch>` is always `ccairgap/<id>` where `<id>` is `<prefix>-<4hex>` per §"Session identifier". `--name` supplies the prefix; omitted, a random `<adj>-<noun>` prefix is used. The full ref (`refs/heads/ccairgap/<prefix>-<4hex>`) is validated once via `git check-ref-format`; on collision with an existing session dir, container, or branch in the workspace repo (`--repo`), the hex suffix is re-rolled (up to 8 attempts) before aborting.
```

**Passage 2** — §"Entrypoint" / container-side claude args step 9 (around `docs/SPEC.md:430`). Find:

```markdown
9. Build the final `claude` args: always `--dangerously-skip-permissions`; `-n "ccairgap"` by default, or `-n "$CCAIRGAP_NAME"` when the env var is set, to seed the `/resume` label and terminal title. Note the `-n` value is intentionally *not* prefixed with `[ccairgap]`: a UserPromptSubmit hook injected by the entrypoint emits `sessionTitle: "[ccairgap]"` (or `"[ccairgap] $CCAIRGAP_NAME"`) on first prompt, and Claude Code's hook layer dedups against the current title — so if `-n` already matched the hook output, the rename would skip and the TUI's "session renamed" side effects (TextInput border recolor, top-border label) would never fire. Then either `-p "$CCAIRGAP_PRINT"` for non-interactive print mode, or nothing for the interactive REPL. `exec claude …`.
```

Replace with:

```markdown
9. Build the final `claude` args: always `--dangerously-skip-permissions`; `-n "ccairgap $CCAIRGAP_NAME"` (CCAIRGAP_NAME carries the session id `<prefix>-<4hex>` from the CLI and is always set; the fallback `-n "ccairgap"` only runs when the entrypoint is executed directly outside the CLI). The `-n` value is intentionally **not** prefixed with `[ccairgap]`: a UserPromptSubmit hook injected by the entrypoint emits `sessionTitle: "[ccairgap] $CCAIRGAP_NAME"` on first prompt, and Claude Code's hook layer dedups against the current title — so if `-n` already matched the hook output, the rename would skip and the TUI's "session renamed" side effects (TextInput border recolor, top-border label) would never fire. Then either `-p "$CCAIRGAP_PRINT"` for non-interactive print mode, or nothing for the interactive REPL. `exec claude …`.
```

**Passage 3** — §"Environment variables" `CCAIRGAP_NAME` row (around `docs/SPEC.md:710`). Find:

```markdown
| `CCAIRGAP_NAME` | `--name` | Session display name; forwarded to `claude -n <name>` in the entrypoint. Unset when `--name` was not passed. |
```

Replace with:

```markdown
| `CCAIRGAP_NAME` | session id | Always set. Carries `<prefix>-<4hex>` from the CLI. Used by the entrypoint to build `-n "ccairgap $CCAIRGAP_NAME"` and by the UserPromptSubmit rename hook to emit `[ccairgap] $CCAIRGAP_NAME`. |
```

- [ ] **Step 4: Add collision-probability note to §"Known constraints"**

Find the §"Known constraints" bullet (around `docs/SPEC.md:770`) that reads:

```markdown
- **Single concurrent session per host recommended.** Multiple simultaneous sessions work but share `$XDG_STATE_HOME/ccairgap/output/`. Sessions don't overlap on `<id>` so repo clones are fine.
```

Replace with:

```markdown
- **Single concurrent session per host recommended.** Multiple simultaneous sessions work but share `$XDG_STATE_HOME/ccairgap/output/`. Ids are `<prefix>-<4hex>`; per §"Session identifier" the hex suffix is randomized so concurrent sessions with the same prefix have a 1/65536 collision probability per pair. On collision, the second `docker run` fails cleanly and the CLI aborts with a message; no half-created state remains beyond the session dir, which `ccairgap discard <id>` clears.
```

- [ ] **Step 5: Update `README.md`**

Grep for the current occurrences to confirm the sites before editing:

```bash
grep -n "<ts>" README.md
```
Expected: 10 lines (17, 21, 97, 108, 123, 127, 129, 135, 277, 278).

Apply these edits one at a time — do **not** run a blind file-wide replace, because the `-n, --name` table row's `<ts>` appears in a different context than the others.

**Edit 1** — `-n, --name` table row (line 135). Find:

```markdown
| `-n, --name <name>` | `<ts>` | no | Session name. Branch becomes `ccairgap/<name>`; forwarded as Claude's session label. Aborts on invalid git ref or branch collision. See notes below. |
```

Replace with:

```markdown
| `-n, --name <name>` | random `<adj>-<noun>` | no | Session id **prefix**. The CLI always appends a 4-hex suffix; the final id is `<name>-<4hex>`. Drives the session dir, docker container (`ccairgap-<id>`), branch (`ccairgap/<id>`), and Claude's session label (`[ccairgap] <id>`). Must be a valid git ref component. See notes below. |
```

**Edit 2** — "Notes on `--name`" paragraph (line 144). Find:

```markdown
The initial `claude -n "<name>"` sets the session label, then on the first user prompt a hook renames the session to `[ccairgap] <name>` (or `[ccairgap]` when unset). That relabeled form is what `/resume` and the TUI's top-border label show. The two-step rename is intentional — matching labels would trigger Claude Code's hook-dedup and skip the TUI rename effect.
```

Replace with:

```markdown
The initial `claude -n "ccairgap <id>"` sets the session label, then on the first user prompt a hook renames the session to `[ccairgap] <id>`. That relabeled form is what `/resume` and the TUI's top-border label show. The two-step rename is intentional — matching labels would trigger Claude Code's hook-dedup and skip the TUI rename effect. `--name` supplies only the **prefix**; the hex suffix is always appended so two launches with the same `--name` never collide on branch, container, or session dir.
```

**Edit 3** — "On exit" git-log example (line 102). Find:

```bash
$ git log --oneline ccairgap/20260418T143022Z
a3f1b2c Wire auth middleware
b4e2d8f Add login route
```

Replace with:

```bash
$ git log --oneline ccairgap/fuzzy-otter-a4f1
a3f1b2c Wire auth middleware
b4e2d8f Add login route
```

**Edit 4** — remaining `<ts>` → `<id>` substitutions. These eight sites are pure placeholder swaps and the surrounding prose does not need rewriting. For each, use Edit with the exact context below:

| Line | Before | After |
|------|--------|-------|
| 17 | `land as \`ccairgap/<ts>\` in your repo.` | `land as \`ccairgap/<id>\` in your repo.` |
| 21 | `the \`ccairgap/<ts>\` branch via \`git fetch\`` | `the \`ccairgap/<id>\` branch via \`git fetch\`` |
| 97 | `Claude's commits land as \`ccairgap/<ts>\` in each repo:` | `Claude's commits land as \`ccairgap/<id>\` in each repo:` |
| 108 | `then \`ccairgap discard <ts>\`.` | `then \`ccairgap discard <id>\`.` |
| 123 | `branch \`ccairgap/<ts>\` created on exit.` | `branch \`ccairgap/<id>\` created on exit.` |
| 127 | `\`$CCAIRGAP_HOME/output/<ts>/<abs-src>/\`.` | `\`$CCAIRGAP_HOME/output/<id>/<abs-src>/\`.` |
| 129 | `Base ref for \`ccairgap/<ts>\`.` | `Base ref for \`ccairgap/<id>\`.` |
| 277 | `\`recover [<ts>]\` ... With no \`<ts>\`, falls back to \`list\`.` | `\`recover [<id>]\` ... With no \`<id>\`, falls back to \`list\`.` |
| 278 | `\`discard <ts>\` \| Delete a session dir` | `\`discard <id>\` \| Delete a session dir` |

After all edits, `grep -n "<ts>" README.md` must return no output.

- [ ] **Step 6: Update `CLAUDE.md`**

Find:

```markdown
- **Host writable paths are closed set** (SPEC §"Host writable paths"): session scratch, `output/`, `~/.claude/projects/<encoded>`, and `ccairgap/<ts>` ref via `git fetch` on exit. Adding any other write path requires SPEC update.
```

Replace with:

```markdown
- **Host writable paths are closed set** (SPEC §"Host writable paths"): session scratch, `output/`, `~/.claude/projects/<encoded>`, and `ccairgap/<id>` ref via `git fetch` on exit. Adding any other write path requires SPEC update.
```

Find:

```markdown
- **Exit trap is best-effort.** SIGKILL of CLI leaves session on disk; user runs `ccairgap recover <ts>`. Handoff must stay idempotent.
```

Replace with:

```markdown
- **Exit trap is best-effort.** SIGKILL of CLI leaves session on disk; user runs `ccairgap recover <id>`. Handoff must stay idempotent.
```

- [ ] **Step 7: Update `SECURITY.md`**

Find:

```markdown
- Real git repositories passed via `--repo` / `--extra-repo` (only `ccairgap/<ts>` ref creation via host-side `git fetch` on exit is permitted).
```

Replace with:

```markdown
- Real git repositories passed via `--repo` / `--extra-repo` (only `ccairgap/<id>` ref creation via host-side `git fetch` on exit is permitted).
```

- [ ] **Step 8: Update skill references**

In `skills/ccairgap-configure/references/config-schema.md`, find the `name` row:

```markdown
| `name` | string | `-n` / `--name` | Session name; branch becomes `ccairgap/<name>`. |
```

Replace with:

```markdown
| `name` | string | `-n` / `--name` | Session id prefix; final id is `<name>-<4hex>`. Branch becomes `ccairgap/<id>`. |
```

Also replace any other `<ts>` occurrences in this file with `<id>`.

In `skills/ccairgap-configure/references/docker-run-args.md`, find:

```markdown
docker run --rm -it --cap-drop=ALL --name ccairgap-<ts> \
```

Replace with:

```markdown
docker run --rm -it --cap-drop=ALL --name ccairgap-<id> \
```

Find:

```markdown
- `--name <custom>` overrides `ccairgap-<ts>` — almost always a bad idea; breaks `ccairgap list` and orphan detection.
```

Replace with:

```markdown
- `--name <custom>` overrides `ccairgap-<id>` — almost always a bad idea; breaks `ccairgap list` and orphan detection.
```

In `skills/ccairgap-configure/references/artifact-decision.md`, replace all four `<ts>` occurrences with `<id>`.

- [ ] **Step 9: Final grep sweep**

Run: `grep -rn "<ts>" docs/ README.md CLAUDE.md SECURITY.md skills/` (via Grep tool)
Expected: zero occurrences outside of `docs/research/` (research docs are historical, leave them).

- [ ] **Step 10: Commit**

```bash
git add docs/SPEC.md README.md CLAUDE.md SECURITY.md skills/ccairgap-configure/references/
git commit -m "docs: replace <ts> with <id> session-identifier nomenclature"
```

---

### Task 8: Final verification

**Depends on:** Task 7
**Commit:** none
**Files:**
- None (verification only).

#### Steps:

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass. `sessionId.test.ts` should show 8 tests.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean tsup bundle.

- [ ] **Step 4: Dry-run smoke test (manual)**

Run: `./dist/cli.js doctor`
Expected: all checks pass.

Optional (if docker + a test repo available):
- `cd <some-git-repo>` and run `./dist/cli.js -p "echo hello"` — session id should print as part of any "recover manually" hint; `ccairgap list` run during/after should show the id in `<prefix>-<4hex>` form.

- [ ] **Step 5: No stray `<ts>` sweep**

Run: `grep -rn "<ts>" docs/SPEC.md README.md CLAUDE.md SECURITY.md skills/`
Expected: zero output (`docs/research/` excluded — historical).

Run: `grep -rn "compactTimestamp\|ts:\s*string\|\bo\.ts\b\|result\.ts\b" src/`
Expected: no matches.
