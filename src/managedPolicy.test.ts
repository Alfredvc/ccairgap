import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveManagedPolicyDir } from "./managedPolicy.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-managed-")));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveManagedPolicyDir", () => {
  it("returns the macOS path when platform=darwin and the dir exists", () => {
    const p = join(root, "Library", "Application Support", "ClaudeCode");
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, "managed-settings.json"), "{}");
    expect(resolveManagedPolicyDir({ platform: "darwin", root })).toBe(p);
  });

  it("returns the Linux path when platform=linux and the dir exists", () => {
    const p = join(root, "etc", "claude-code");
    mkdirSync(p, { recursive: true });
    expect(resolveManagedPolicyDir({ platform: "linux", root })).toBe(p);
  });

  it("returns undefined when the dir does not exist", () => {
    expect(resolveManagedPolicyDir({ platform: "darwin", root })).toBeUndefined();
    expect(resolveManagedPolicyDir({ platform: "linux", root })).toBeUndefined();
  });

  it("returns undefined on Windows (ccairgap is POSIX-only)", () => {
    const p = join(root, "Library", "Application Support", "ClaudeCode");
    mkdirSync(p, { recursive: true });
    expect(resolveManagedPolicyDir({ platform: "win32", root })).toBeUndefined();
  });
});
