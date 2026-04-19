import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractLastJsonStringField,
  isUuid,
  listProjectSessions,
  readCustomTitle,
  resolveResumeArg,
} from "./resumeResolver.js";

describe("isUuid", () => {
  it("accepts canonical lowercase UUIDs", () => {
    expect(isUuid("01234567-89ab-cdef-0123-456789abcdef")).toBe(true);
  });
  it("accepts uppercase UUIDs", () => {
    expect(isUuid("0123ABCD-89AB-CDEF-0123-456789ABCDEF")).toBe(true);
  });
  it("rejects non-UUID strings", () => {
    expect(isUuid("my session title")).toBe(false);
    expect(isUuid("01234567-89ab-cdef-0123-456789abcde")).toBe(false);
    expect(isUuid("")).toBe(false);
  });
});

describe("extractLastJsonStringField", () => {
  it("returns undefined when key absent", () => {
    expect(extractLastJsonStringField('{"other":"x"}', "customTitle")).toBeUndefined();
  });
  it("returns the single match", () => {
    expect(extractLastJsonStringField('{"customTitle":"hello"}', "customTitle")).toBe("hello");
  });
  it("returns the LAST occurrence when multiple are present", () => {
    const text =
      '{"customTitle":"first"}\n{"customTitle":"second"}\n{"customTitle":"third"}\n';
    expect(extractLastJsonStringField(text, "customTitle")).toBe("third");
  });
  it("handles key-space-value form", () => {
    expect(extractLastJsonStringField('{"customTitle": "spaced"}', "customTitle")).toBe("spaced");
  });
  it("unescapes embedded quotes", () => {
    const raw = '{"customTitle":"hello \\"world\\""}';
    expect(extractLastJsonStringField(raw, "customTitle")).toBe('hello "world"');
  });
  it("handles escaped backslashes before quote", () => {
    const raw = '{"customTitle":"path\\\\"}'; // value is `path\`
    expect(extractLastJsonStringField(raw, "customTitle")).toBe("path\\");
  });
});

describe("readCustomTitle", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "resume-title-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns undefined for empty file", async () => {
    const p = join(root, "a.jsonl");
    writeFileSync(p, "");
    expect(await readCustomTitle(p)).toBeUndefined();
  });

  it("returns customTitle from tail for small file", async () => {
    const p = join(root, "a.jsonl");
    writeFileSync(
      p,
      '{"type":"user","message":{}}\n' +
        '{"type":"custom-title","customTitle":"my-title","sessionId":"x"}\n',
    );
    expect(await readCustomTitle(p)).toBe("my-title");
  });

  it("returns LAST customTitle on rename (tail wins)", async () => {
    const p = join(root, "a.jsonl");
    writeFileSync(
      p,
      '{"type":"custom-title","customTitle":"old"}\n' +
        '{"type":"user"}\n' +
        '{"type":"custom-title","customTitle":"new"}\n',
    );
    expect(await readCustomTitle(p)).toBe("new");
  });

  it("falls back to head when tail does not contain customTitle", async () => {
    // Large file: pad with user messages between head and tail so the tail
    // window doesn't reach the head's customTitle entry.
    const p = join(root, "a.jsonl");
    const header = '{"type":"custom-title","customTitle":"head-title"}\n';
    const filler = ('{"type":"user","message":{"content":"x"}}\n').repeat(2000);
    writeFileSync(p, header + filler);
    expect(await readCustomTitle(p)).toBe("head-title");
  });
});

describe("listProjectSessions", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "resume-list-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("returns empty list when dir missing", async () => {
    expect(await listProjectSessions(join(root, "nope"))).toEqual([]);
  });

  it("enumerates .jsonl files with valid UUID names", async () => {
    const dir = join(root, "projects");
    mkdirSync(dir, { recursive: true });
    const u1 = "11111111-1111-1111-1111-111111111111";
    const u2 = "22222222-2222-2222-2222-222222222222";
    writeFileSync(join(dir, `${u1}.jsonl`), '{"type":"custom-title","customTitle":"one"}\n');
    writeFileSync(join(dir, `${u2}.jsonl`), '{"type":"user"}\n'); // no title
    writeFileSync(join(dir, "not-a-uuid.jsonl"), "ignored\n");
    writeFileSync(join(dir, "empty.jsonl"), "");
    const got = await listProjectSessions(dir);
    const byUuid = Object.fromEntries(got.map((c) => [c.uuid, c]));
    expect(byUuid[u1]!.customTitle).toBe("one");
    expect(byUuid[u2]!.customTitle).toBeUndefined();
    expect(byUuid["not-a-uuid"]).toBeUndefined();
    expect(got).toHaveLength(2);
  });
});

describe("resolveResumeArg", () => {
  let root: string;
  let hostClaude: string;
  const workspace = "/Users/alice/src/proj";
  const encoded = "-Users-alice-src-proj";

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "resume-arg-"));
    hostClaude = join(root, ".claude");
    mkdirSync(join(hostClaude, "projects", encoded), { recursive: true });
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeSession(uuid: string, customTitle: string | undefined, mtimeMs?: number): void {
    const p = join(hostClaude, "projects", encoded, `${uuid}.jsonl`);
    const lines = ['{"type":"user"}'];
    if (customTitle !== undefined) {
      lines.push(
        `{"type":"custom-title","customTitle":${JSON.stringify(customTitle)},"sessionId":${JSON.stringify(uuid)}}`,
      );
    }
    writeFileSync(p, lines.join("\n") + "\n");
    if (mtimeMs !== undefined) {
      utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
    }
  }

  it("passes a UUID through without scanning transcripts", async () => {
    const uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    // No transcript file exists — resolver must still return the UUID.
    const got = await resolveResumeArg({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      arg: uuid,
    });
    expect(got).toEqual({ uuid });
  });

  it("resolves a session by exact custom title (case-insensitive)", async () => {
    const u1 = "11111111-1111-1111-1111-111111111111";
    writeSession(u1, "My Session");
    writeSession("22222222-2222-2222-2222-222222222222", "Other");
    const got = await resolveResumeArg({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      arg: "my session",
    });
    expect(got.uuid).toBe(u1);
    expect(got.customTitle).toBe("My Session");
  });

  it("throws with candidate list when no title matches", async () => {
    writeSession("11111111-1111-1111-1111-111111111111", "alpha");
    writeSession("22222222-2222-2222-2222-222222222222", "beta");
    let caught: Error | undefined;
    try {
      await resolveResumeArg({
        hostClaudeDir: hostClaude,
        workspaceHostPath: workspace,
        arg: "gamma",
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught!.message).toMatch(/no session with that exact name/);
    expect(caught!.message).toMatch(/alpha/);
    expect(caught!.message).toMatch(/beta/);
  });

  it("throws a distinct message when no titled sessions exist at all", async () => {
    writeSession("11111111-1111-1111-1111-111111111111", undefined);
    await expect(
      resolveResumeArg({
        hostClaudeDir: hostClaude,
        workspaceHostPath: workspace,
        arg: "anything",
      }),
    ).rejects.toThrow(/no session with that name found/);
  });

  it("throws with UUIDs to pick when multiple sessions share a title", async () => {
    const u1 = "11111111-1111-1111-1111-111111111111";
    const u2 = "22222222-2222-2222-2222-222222222222";
    writeSession(u1, "shared");
    writeSession(u2, "shared");
    await expect(
      resolveResumeArg({
        hostClaudeDir: hostClaude,
        workspaceHostPath: workspace,
        arg: "shared",
      }),
    ).rejects.toThrow(new RegExp(`2 sessions share this name[\\s\\S]*${u1}[\\s\\S]*${u2}|${u2}[\\s\\S]*${u1}`));
  });

  it("matches the LAST customTitle (renamed sessions resolve by new name)", async () => {
    const u1 = "11111111-1111-1111-1111-111111111111";
    const p = join(hostClaude, "projects", encoded, `${u1}.jsonl`);
    writeFileSync(
      p,
      [
        '{"type":"custom-title","customTitle":"old-name"}',
        '{"type":"user"}',
        '{"type":"custom-title","customTitle":"new-name"}',
      ].join("\n") + "\n",
    );
    const got = await resolveResumeArg({
      hostClaudeDir: hostClaude,
      workspaceHostPath: workspace,
      arg: "new-name",
    });
    expect(got.uuid).toBe(u1);

    await expect(
      resolveResumeArg({
        hostClaudeDir: hostClaude,
        workspaceHostPath: workspace,
        arg: "old-name",
      }),
    ).rejects.toThrow(/no session with that exact name/);
  });
});
