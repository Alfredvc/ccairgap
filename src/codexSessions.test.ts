import {
  existsSync,
  chmodSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyCodexSessions } from "./codexSessions.js";
import type { Manifest } from "./manifest.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ccairgap-codex-sessions-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function manifest(hostHome: string | undefined): Manifest {
  return {
    version: 1,
    agent: "codex",
    cli_version: "test",
    image_tag: "test:1",
    created_at: "2026-05-13T00:00:00.000Z",
    repos: [],
    ...(hostHome === undefined ? {} : { codex: { host_home: hostHome } }),
    claude_code: {},
  };
}

function paths() {
  const sessionDir = join(root, "session");
  const sourceRoot = join(sessionDir, "codex-sessions");
  const hostHome = join(root, "host-codex");
  mkdirSync(hostHome, { recursive: true });
  return { sessionDir, sourceRoot, hostHome };
}

function writeRollout(
  sourceRoot: string,
  rel = "2026/05/13/rollout-2026-05-13T00-00-00-000Z-abc123.jsonl",
  content = "{\"type\":\"session\"}\n",
): string {
  const file = join(sourceRoot, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

function destination(hostHome: string): string {
  return join(
    hostHome,
    "sessions",
    "2026",
    "05",
    "13",
    "rollout-2026-05-13T00-00-00-000Z-abc123.jsonl",
  );
}

describe("copyCodexSessions", () => {
  it("no-ops when the session has no Codex sessions directory", async () => {
    const { sessionDir, hostHome } = paths();
    mkdirSync(sessionDir, { recursive: true });

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
    });

    expect(result).toMatchObject({ status: "ok", copied: 0, existing: 0 });
    expect(existsSync(join(hostHome, "sessions"))).toBe(false);
  });

  it("preserves when the source tree cannot be scanned", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    mkdirSync(sourceRoot, { recursive: true });
    chmodSync(sourceRoot, 0o000);
    try {
      const result = await copyCodexSessions({
        sessionDir,
        manifest: manifest(hostHome),
      });

      expect(result.status).toBe("preserve");
      expect(result.warnings.join("\n")).toContain("Codex sessions scan failed");
      expect(existsSync(join(hostHome, "sessions"))).toBe(false);
    } finally {
      chmodSync(sourceRoot, 0o700);
    }
  });

  it("copies valid rollout JSONL files to manifest.codex.host_home sessions", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    writeRollout(sourceRoot);

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
      protectedHostPaths: [],
    });

    const dest = destination(hostHome);
    expect(result).toMatchObject({ status: "ok", copied: 1, existing: 0 });
    expect(readFileSync(dest, "utf8")).toBe("{\"type\":\"session\"}\n");
    expect(statSync(join(hostHome, "sessions", "2026")).mode & 0o777).toBe(0o700);
    expect(statSync(join(hostHome, "sessions", "2026", "05", "13")).mode & 0o777).toBe(0o700);
  });

  it("does not copy Codex auth, logs, history, SQLite, plugin, or marketplace state", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    writeRollout(sourceRoot);
    const codexHome = join(sessionDir, "codex-home");
    mkdirSync(join(codexHome, "logs"), { recursive: true });
    mkdirSync(join(codexHome, "plugins"), { recursive: true });
    mkdirSync(join(codexHome, "marketplace"), { recursive: true });
    writeFileSync(join(codexHome, "auth.json"), "{\"OPENAI_API_KEY\":\"secret\"}\n");
    writeFileSync(join(codexHome, "history.jsonl"), "{}\n");
    writeFileSync(join(codexHome, "state.sqlite"), "sqlite");
    writeFileSync(join(codexHome, "logs", "codex.log"), "log");
    writeFileSync(join(codexHome, "plugins", "plugin.json"), "{}\n");
    writeFileSync(join(codexHome, "marketplace", "index.json"), "{}\n");

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
    });

    expect(result.status).toBe("ok");
    expect(existsSync(join(hostHome, "auth.json"))).toBe(false);
    expect(existsSync(join(hostHome, "history.jsonl"))).toBe(false);
    expect(existsSync(join(hostHome, "state.sqlite"))).toBe(false);
    expect(existsSync(join(hostHome, "logs"))).toBe(false);
    expect(existsSync(join(hostHome, "plugins"))).toBe(false);
    expect(existsSync(join(hostHome, "marketplace"))).toBe(false);
    expect(existsSync(destination(hostHome))).toBe(true);
  });

  it("preflights the whole source tree before creating host destinations", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    writeRollout(sourceRoot);
    symlinkSync(
      join(sourceRoot, "2026", "05", "13", "rollout-2026-05-13T00-00-00-000Z-abc123.jsonl"),
      join(sourceRoot, "2026", "05", "13", "rollout-symlink.jsonl"),
    );

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
      protectedHostPaths: [],
    });

    expect(result.status).toBe("preserve");
    expect(result.warnings.join("\n")).toContain("symbolic link");
    expect(existsSync(join(hostHome, "sessions"))).toBe(false);
  });

  it("rejects hardlinked rollout files", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    const file = writeRollout(sourceRoot);
    linkSync(file, join(sourceRoot, "2026", "05", "13", "rollout-hardlink.jsonl"));

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
    });

    expect(result.status).toBe("preserve");
    expect(result.warnings.join("\n")).toContain("hardlink");
    expect(existsSync(join(hostHome, "sessions"))).toBe(false);
  });

  it("rejects unexpected entries and traversal-like names", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    writeRollout(sourceRoot);
    writeFileSync(join(sourceRoot, "notes.txt"), "not a rollout");

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
    });

    expect(result.status).toBe("preserve");
    expect(result.warnings.join("\n")).toContain("unexpected");
    expect(existsSync(join(hostHome, "sessions"))).toBe(false);
  });

  it("requires manifest.codex.host_home to be present and absolute", async () => {
    const { sessionDir, sourceRoot } = paths();
    writeRollout(sourceRoot);

    const missing = await copyCodexSessions({
      sessionDir,
      manifest: manifest(undefined),
    });
    const relative = await copyCodexSessions({
      sessionDir,
      manifest: manifest("relative/.codex"),
    });

    expect(missing.status).toBe("preserve");
    expect(missing.warnings.join("\n")).toContain("codex.host_home");
    expect(relative.status).toBe("preserve");
    expect(relative.warnings.join("\n")).toContain("absolute");
  });

  it("rejects host Codex homes that overlap protected host paths", async () => {
    const repo = join(root, "repo");
    const hostHome = join(repo, ".codex");
    const sessionDir = join(root, "session");
    const sourceRoot = join(sessionDir, "codex-sessions");
    mkdirSync(hostHome, { recursive: true });
    writeRollout(sourceRoot);

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
      protectedHostPaths: [repo],
    });

    expect(result.status).toBe("preserve");
    expect(result.warnings.join("\n")).toContain("protected host path");
    expect(existsSync(join(hostHome, "sessions"))).toBe(false);
  });

  it("rejects host Codex homes whose real path overlaps protected host paths", async () => {
    const repo = join(root, "repo");
    const link = join(root, "repo-link");
    const hostHome = join(link, ".codex");
    const sessionDir = join(root, "session");
    const sourceRoot = join(sessionDir, "codex-sessions");
    mkdirSync(join(repo, ".codex"), { recursive: true });
    symlinkSync(repo, link);
    writeRollout(sourceRoot);

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
      protectedHostPaths: [repo],
    });

    expect(result.status).toBe("preserve");
    expect(result.warnings.join("\n")).toContain("protected host path");
    expect(existsSync(join(repo, ".codex", "sessions"))).toBe(false);
  });

  it("rejects symlinked destination ancestors before writing", async () => {
    const realHomeParent = join(root, "real-home");
    const linkHomeParent = join(root, "linked-home");
    const hostHome = join(linkHomeParent, ".codex");
    const sessionDir = join(root, "session");
    const sourceRoot = join(sessionDir, "codex-sessions");
    mkdirSync(join(realHomeParent, ".codex"), { recursive: true });
    symlinkSync(realHomeParent, linkHomeParent);
    writeRollout(sourceRoot);

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
    });

    expect(result.status).toBe("preserve");
    expect(result.warnings.join("\n")).toContain("symbolic link");
    expect(existsSync(join(realHomeParent, ".codex", "sessions"))).toBe(false);
  });


  it("rejects symlinked destination parents", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    const outside = join(root, "outside");
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(hostHome, "sessions"), { recursive: true });
    symlinkSync(outside, join(hostHome, "sessions", "2026"));
    writeRollout(sourceRoot);

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
    });

    expect(result.status).toBe("preserve");
    expect(result.warnings.join("\n")).toContain("destination parent is a symbolic link");
    expect(existsSync(join(outside, "05"))).toBe(false);
  });

  it("treats hash-identical destination collisions as success", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    writeRollout(sourceRoot);
    const dest = destination(hostHome);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, "{\"type\":\"session\"}\n");

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
    });

    expect(result).toMatchObject({ status: "ok", copied: 0, existing: 1 });
    expect(readFileSync(dest, "utf8")).toBe("{\"type\":\"session\"}\n");
  });

  it("preserves the session on changed destination collisions", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    writeRollout(sourceRoot);
    const dest = destination(hostHome);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, "{\"type\":\"different\"}\n");

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
    });

    expect(result.status).toBe("preserve");
    expect(result.warnings.join("\n")).toContain("destination already exists with different content");
    expect(readFileSync(dest, "utf8")).toBe("{\"type\":\"different\"}\n");
  });

  it("preserves when another process creates the destination during publish", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    writeRollout(sourceRoot);
    const dest = destination(hostHome);

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
      beforePublish: (publishedPath) => {
        if (publishedPath !== dest || existsSync(dest)) return;
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, "{\"type\":\"raced\"}\n");
      },
    });

    expect(result.status).toBe("preserve");
    expect(readFileSync(dest, "utf8")).toBe("{\"type\":\"raced\"}\n");
  });

  it("removes temporary files after successful publication", async () => {
    const { sessionDir, sourceRoot, hostHome } = paths();
    writeRollout(sourceRoot);

    const result = await copyCodexSessions({
      sessionDir,
      manifest: manifest(hostHome),
    });

    expect(result.status).toBe("ok");
    const content = lstatSync(dirname(destination(hostHome))).isDirectory()
      ? readFileSync(destination(hostHome), "utf8")
      : "";
    expect(content).toBe("{\"type\":\"session\"}\n");
    expect(
      readdirSync(dirname(destination(hostHome))).some((entry) =>
        entry.startsWith(".ccairgap-rollout.tmp"),
      ),
    ).toBe(false);
  });
});
