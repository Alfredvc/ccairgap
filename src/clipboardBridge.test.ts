import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectClipboardMode,
  buildClipboardMounts,
  buildClipboardEnvVars,
  detectAndSetupClipboardBridge,
  type ClipboardMode,
} from "./clipboardBridge.js";

describe("detectClipboardMode", () => {
  it("returns none on unsupported platforms", () => {
    const r = detectClipboardMode({
      platform: "freebsd",
      env: {},
      isWsl2: () => false,
      hasCommand: () => true,
    });
    expect(r.mode).toBe("none");
    expect(r.warning).toBeUndefined();
  });

  it("returns macos when darwin + pngpaste present", () => {
    const r = detectClipboardMode({
      platform: "darwin",
      env: {},
      isWsl2: () => false,
      hasCommand: (c) => c === "pngpaste",
    });
    expect(r.mode).toBe("macos");
    expect(r.warning).toBeUndefined();
  });

  it("returns none on darwin without pngpaste AND emits a warning", () => {
    const r = detectClipboardMode({
      platform: "darwin",
      env: {},
      isWsl2: () => false,
      hasCommand: () => false,
    });
    expect(r.mode).toBe("none");
    expect(r.warning).toMatch(/pngpaste/);
    expect(r.warning).toMatch(/brew install/);
  });

  it("returns wsl2 when WSLInterop exists + wl-paste present", () => {
    const r = detectClipboardMode({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      isWsl2: () => true,
      hasCommand: (c) => c === "wl-paste",
    });
    expect(r.mode).toBe("wsl2");
  });

  it("returns wayland when WAYLAND_DISPLAY set + wl-paste present (non-WSL2)", () => {
    const r = detectClipboardMode({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      isWsl2: () => false,
      hasCommand: (c) => c === "wl-paste",
    });
    expect(r.mode).toBe("wayland");
  });

  it("returns x11 when DISPLAY set + xclip present (no WAYLAND_DISPLAY)", () => {
    const r = detectClipboardMode({
      platform: "linux",
      env: { DISPLAY: ":0" },
      isWsl2: () => false,
      hasCommand: (c) => c === "xclip",
    });
    expect(r.mode).toBe("x11");
  });

  it("returns none on linux without any display env", () => {
    const r = detectClipboardMode({
      platform: "linux",
      env: {},
      isWsl2: () => false,
      hasCommand: () => true,
    });
    expect(r.mode).toBe("none");
    expect(r.warning).toBeUndefined();
  });

  it("returns none on wayland without wl-paste AND emits a warning", () => {
    const r = detectClipboardMode({
      platform: "linux",
      env: { WAYLAND_DISPLAY: "wayland-0" },
      isWsl2: () => false,
      hasCommand: () => false,
    });
    expect(r.mode).toBe("none");
    expect(r.warning).toMatch(/wl-clipboard/);
  });

  it("returns none on x11 without xclip AND emits a warning", () => {
    const r = detectClipboardMode({
      platform: "linux",
      env: { DISPLAY: ":0" },
      isWsl2: () => false,
      hasCommand: () => false,
    });
    expect(r.mode).toBe("none");
    expect(r.warning).toMatch(/xclip/);
  });

  it("returns none on wsl2 without wl-paste AND emits a warning", () => {
    const r = detectClipboardMode({
      platform: "linux",
      env: {},
      isWsl2: () => true,
      hasCommand: () => false,
    });
    expect(r.mode).toBe("none");
    expect(r.warning).toMatch(/wl-clipboard/);
  });
});

describe("buildClipboardMounts", () => {
  it("returns empty array when mode is none", () => {
    expect(buildClipboardMounts("none", "/session/abc")).toEqual([]);
  });

  const activeModes: ClipboardMode[] = ["macos", "wayland", "wsl2", "x11"];
  for (const m of activeModes) {
    it(`returns the bridge DIRECTORY RO mount for mode=${m}`, () => {
      expect(buildClipboardMounts(m, "/session/abc")).toEqual([
        {
          src: "/session/abc/clipboard-bridge",
          dst: "/run/ccairgap-clipboard",
          mode: "ro",
          source: { kind: "clipboard-bridge" },
        },
      ]);
    });
  }
});

describe("buildClipboardEnvVars", () => {
  it("returns empty map when mode is none", () => {
    expect(buildClipboardEnvVars("none")).toEqual({});
  });

  const activeModes: ClipboardMode[] = ["macos", "wayland", "wsl2", "x11"];
  for (const m of activeModes) {
    it(`returns CCAIRGAP_CLIPBOARD_MODE for mode=${m} (no WAYLAND_DISPLAY sentinel)`, () => {
      expect(buildClipboardEnvVars(m)).toEqual({
        CCAIRGAP_CLIPBOARD_MODE: "host-bridge",
      });
    });
  }
});

describe("detectAndSetupClipboardBridge", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ccairgap-clip-test-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns mode=none when enabled=false", async () => {
    const r = await detectAndSetupClipboardBridge(tmp, { enabled: false });
    expect(r.mode).toBe("none");
    expect(r.mounts).toEqual([]);
    expect(r.envVars).toEqual({});
    await expect(r.cleanup()).resolves.toBeUndefined();
  });
});
