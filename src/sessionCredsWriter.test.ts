import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, statSync, readdirSync } from "node:fs";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import { writeSessionCreds } from "./sessionCredsWriter.js";

describe("writeSessionCreds", () => {
  let session: string;

  beforeEach(() => {
    session = mkdtempSync(join(tmpdir(), "ccairgap-creds-writer-"));
  });

  afterEach(() => {
    rmSync(session, { recursive: true, force: true });
  });

  it("creates creds/.credentials.json with given JSON", () => {
    writeSessionCreds(session, '{"x":1}');
    const dest = join(session, "creds", ".credentials.json");
    expect(readFileSync(dest, "utf8")).toBe('{"x":1}');
  });

  it("creates the creds/ subdir if absent", () => {
    writeSessionCreds(session, "{}");
    expect(statSync(join(session, "creds")).isDirectory()).toBe(true);
  });

  it("file mode is 0600", () => {
    writeSessionCreds(session, "{}");
    const dest = join(session, "creds", ".credentials.json");
    const m = statSync(dest).mode & 0o777;
    // Windows ignores chmod; only enforce on POSIX.
    if (platform() !== "win32") expect(m).toBe(0o600);
  });

  it("clobbers an existing file (rename-over)", () => {
    const credsDir = join(session, "creds");
    mkdirSync(credsDir);
    writeFileSync(join(credsDir, ".credentials.json"), "OLD", { mode: 0o600 });
    writeSessionCreds(session, "NEW");
    expect(readFileSync(join(credsDir, ".credentials.json"), "utf8")).toBe("NEW");
  });

  it("removes its tmp file on success", () => {
    writeSessionCreds(session, "{}");
    const credsDir = join(session, "creds");
    const leftovers = readdirSync(credsDir).filter((f) =>
      f.startsWith(".credentials.json.tmp."),
    );
    expect(leftovers).toEqual([]);
  });

  it("preserves 0600 even if the existing file was 0644", () => {
    if (platform() === "win32") return;
    const credsDir = join(session, "creds");
    mkdirSync(credsDir);
    writeFileSync(join(credsDir, ".credentials.json"), "OLD", { mode: 0o644 });
    writeSessionCreds(session, "NEW");
    const m = statSync(join(credsDir, ".credentials.json")).mode & 0o777;
    expect(m).toBe(0o600);
  });
});
