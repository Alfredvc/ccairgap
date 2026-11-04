import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const execaMock = vi.hoisted(() => vi.fn());
vi.mock("execa", () => ({ execa: execaMock }));

import { buildClaudeSymlinkOverlay } from "./claudeSymlinkOverlay.js";

describe("buildClaudeSymlinkOverlay rsync exit codes", () => {
  let root: string;
  let claudeDir: string;
  let stageDir: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ccairgap-symlink-exit-test-"));
    claudeDir = join(root, ".claude");
    stageDir = join(root, "stage");
    mkdirSync(claudeDir);
    mkdirSync(join(root, "ext"));
    symlinkSync(join(root, "ext"), join(claudeDir, "skills"));
    warn = vi.spyOn(console, "error").mockImplementation(() => {});
    execaMock.mockReset();
  });

  afterEach(() => {
    warn.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  it.each([23, 24])("warns and keeps the mount on exit %i", async (exitCode) => {
    execaMock.mockRejectedValue(Object.assign(new Error("rsync failed"), { exitCode }));
    const mounts = await buildClaudeSymlinkOverlay(claudeDir, stageDir);
    expect(mounts.map((m) => m.dst)).toEqual(["/host-claude/skills"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`rsync exit ${exitCode}`));
  });

  it("throws on other exit codes", async () => {
    execaMock.mockRejectedValue(Object.assign(new Error("no space"), { exitCode: 11 }));
    await expect(buildClaudeSymlinkOverlay(claudeDir, stageDir)).rejects.toThrow("no space");
  });

  it("throws when rsync cannot start (no exit code)", async () => {
    execaMock.mockRejectedValue(new Error("spawn rsync ENOENT"));
    await expect(buildClaudeSymlinkOverlay(claudeDir, stageDir)).rejects.toThrow("ENOENT");
  });
});
