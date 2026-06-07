import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectClipboardMode,
  buildClipboardMounts,
  buildClipboardEnvVars,
  detectAndSetupClipboardBridge,
  startHostWatcher,
  MACOS_WATCHER_SCRIPT,
  type ClipboardMode,
} from "./clipboardBridge.js";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function countLines(path: string): number {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, "utf8").trim();
  return text === "" ? 0 : text.split("\n").length;
}

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

  it("returns macos on darwin (osascript is built-in, no hasCommand check)", () => {
    const r = detectClipboardMode({
      platform: "darwin",
      env: {},
      isWsl2: () => false,
      hasCommand: () => false, // irrelevant for darwin
    });
    expect(r.mode).toBe("macos");
    expect(r.warning).toBeUndefined();
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

describe("MACOS_WATCHER_SCRIPT", () => {
  it("checks the pasteboard change count before exporting PNG data", () => {
    const changeCountIndex = MACOS_WATCHER_SCRIPT.indexOf("changeCount");
    const pngExportIndex = MACOS_WATCHER_SCRIPT.indexOf("PNGf");

    expect(changeCountIndex).toBeGreaterThanOrEqual(0);
    expect(pngExportIndex).toBeGreaterThanOrEqual(0);
    expect(changeCountIndex).toBeLessThan(pngExportIndex);
  });
});

describe("startHostWatcher", () => {
  let tmp: string;
  let oldPath: string | undefined;
  let oldFakePidPath: string | undefined;
  let oldFakeExportLog: string | undefined;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "ccairgap-clip-watch-test-"));
    oldPath = process.env.PATH;
    oldFakePidPath = process.env.CCAIRGAP_FAKE_OSASCRIPT_PID;
    oldFakeExportLog = process.env.CCAIRGAP_FAKE_EXPORT_LOG;
  });

  afterEach(() => {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;

    if (oldFakePidPath === undefined) delete process.env.CCAIRGAP_FAKE_OSASCRIPT_PID;
    else process.env.CCAIRGAP_FAKE_OSASCRIPT_PID = oldFakePidPath;

    if (oldFakeExportLog === undefined) delete process.env.CCAIRGAP_FAKE_EXPORT_LOG;
    else process.env.CCAIRGAP_FAKE_EXPORT_LOG = oldFakeExportLog;

    rmSync(tmp, { recursive: true, force: true });
  });

  it("cleanup terminates an in-flight macOS osascript child", async () => {
    const binDir = join(tmp, "bin");
    const fakePidPath = join(tmp, "osascript.pid");
    const fakeOsascript = join(binDir, "osascript");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      fakeOsascript,
      `#!/bin/sh
echo "$$" > "$CCAIRGAP_FAKE_OSASCRIPT_PID"
trap 'exit 0' TERM
while :; do sleep 1; done
`,
    );
    chmodSync(fakeOsascript, 0o755);

    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.CCAIRGAP_FAKE_OSASCRIPT_PID = fakePidPath;

    let fakePid: number | undefined;
    const started = await startHostWatcher("macos", tmp);
    try {
      expect(started).not.toBeNull();

      for (let i = 0; i < 20 && !existsSync(fakePidPath); i++) {
        await delay(25);
      }
      expect(existsSync(fakePidPath)).toBe(true);

      fakePid = Number(readFileSync(fakePidPath, "utf8").trim());
      expect(processIsAlive(fakePid)).toBe(true);

      await started!.cleanup();

      for (let i = 0; i < 20 && processIsAlive(fakePid); i++) {
        await delay(25);
      }
      expect(processIsAlive(fakePid)).toBe(false);
    } finally {
      await started?.cleanup();
      if (fakePid !== undefined && processIsAlive(fakePid)) {
        try { process.kill(fakePid, "SIGKILL"); } catch { /* already dead */ }
      }
    }
  });

  it("does not export PNG again while the macOS pasteboard change count is unchanged", async () => {
    const binDir = join(tmp, "bin");
    const exportLog = join(tmp, "exports.log");
    const fakeOsascript = join(binDir, "osascript");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      fakeOsascript,
      `#!/bin/sh
case "$*" in
  *changeCount*)
    echo 42
    exit 0
    ;;
esac

for arg in "$@"; do
  case "$arg" in
    *'POSIX file "'*)
      out=\${arg#*POSIX file \\"}
      out=\${out%%\\"*}
      printf png > "$out"
      echo export >> "$CCAIRGAP_FAKE_EXPORT_LOG"
      exit 0
      ;;
  esac
done
exit 1
`,
    );
    chmodSync(fakeOsascript, 0o755);

    process.env.PATH = `${binDir}:${oldPath ?? ""}`;
    process.env.CCAIRGAP_FAKE_EXPORT_LOG = exportLog;

    const started = await startHostWatcher("macos", tmp);
    try {
      expect(started).not.toBeNull();

      for (let i = 0; i < 20 && countLines(exportLog) === 0; i++) {
        await delay(25);
      }
      expect(countLines(exportLog)).toBe(1);

      await delay(1200);
      expect(countLines(exportLog)).toBe(1);
    } finally {
      await started?.cleanup();
    }
  });
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
