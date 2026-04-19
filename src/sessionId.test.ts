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
