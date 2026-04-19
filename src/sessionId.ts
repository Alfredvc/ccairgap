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

/**
 * Names of containers currently RUNNING (not `-a`). Shared between orphan scan
 * (which filters sessions with live containers out of `ccairgap list`) and
 * `ccairgap recover` (which refuses to run against a live session). Both
 * callers need the same "is this session live?" truth; keep it single-source.
 *
 * Best-effort: docker errors return an empty set so callers degrade gracefully
 * rather than bricking on a broken docker CLI.
 */
export async function runningContainerNames(): Promise<Set<string>> {
  try {
    const { stdout } = await execa("docker", ["ps", "--format", "{{.Names}}"]);
    return new Set(stdout.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}
