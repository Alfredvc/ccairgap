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

