import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { execaSync } from "execa";
import type { Mount } from "./mounts.js";

export type ClipboardMode = "none" | "macos" | "wayland" | "wsl2" | "x11";

/** Dependencies for `detectClipboardMode`. Injected for testability. */
export interface DetectDeps {
  platform: NodeJS.Platform | string;
  env: NodeJS.ProcessEnv;
  isWsl2: () => boolean;
  hasCommand: (cmd: string) => boolean;
}

export interface DetectResult {
  mode: ClipboardMode;
  /** Install hint emitted when the platform is supported but the tool is missing. Absent when mode selects cleanly. */
  warning?: string;
}

/**
 * Decide which clipboard-watcher flavor to run based on host OS and installed
 * tools. **Pure** — returns `{ mode, warning? }`. The caller decides whether
 * to log the warning (launch.ts logs once; `doctor` enumerates all modes).
 */
export function detectClipboardMode(deps: DetectDeps): DetectResult {
  if (deps.platform === "darwin") {
    // osascript is a macOS built-in — always present, no install required.
    return { mode: "macos" };
  }

  if (deps.isWsl2()) {
    if (deps.hasCommand("wl-paste")) return { mode: "wsl2" };
    return {
      mode: "none",
      warning: "ccairgap: clipboard passthrough disabled — wl-paste not found. Install wl-clipboard: sudo apt install wl-clipboard",
    };
  }

  if (deps.platform === "linux") {
    if (deps.env.WAYLAND_DISPLAY) {
      if (deps.hasCommand("wl-paste")) return { mode: "wayland" };
      return {
        mode: "none",
        warning: "ccairgap: clipboard passthrough disabled — wl-paste not found. Install wl-clipboard: sudo apt install wl-clipboard",
      };
    }
    if (deps.env.DISPLAY) {
      if (deps.hasCommand("xclip")) return { mode: "x11" };
      return {
        mode: "none",
        warning: "ccairgap: clipboard passthrough disabled — xclip not found. Install xclip: sudo apt install xclip",
      };
    }
  }

  return { mode: "none" };
}

/**
 * Build the single bridge-DIRECTORY RO mount. The whole directory is mounted
 * (not just current.png) so docker never hits ENOENT when the watcher has not
 * yet produced output — a common case on first launch with no image on the
 * clipboard.
 */
export function buildClipboardMounts(mode: ClipboardMode, sessionDir: string): Mount[] {
  if (mode === "none") return [];
  return [
    {
      src: join(sessionDir, "clipboard-bridge"),
      dst: "/run/ccairgap-clipboard",
      mode: "ro",
      source: { kind: "clipboard-bridge" },
    },
  ];
}

/**
 * Env vars injected into `docker run`. `CCAIRGAP_CLIPBOARD_MODE` is the single
 * flag the entrypoint keys on to install the shim. No `WAYLAND_DISPLAY`
 * sentinel — Claude Code does not examine `$WAYLAND_DISPLAY` before invoking
 * `wl-paste` (verified in ../claude-code/src/utils/imagePaste.ts:65-67).
 */
export function buildClipboardEnvVars(mode: ClipboardMode): Record<string, string> {
  if (mode === "none") return {};
  return { CCAIRGAP_CLIPBOARD_MODE: "host-bridge" };
}

/** WSL2 detection via `/proc/sys/fs/binfmt_misc/WSLInterop` existence. */
export function isWsl2(): boolean {
  try {
    return existsSync("/proc/sys/fs/binfmt_misc/WSLInterop");
  } catch {
    return false;
  }
}

/** Check if a command exists on PATH. Uses positional arg to avoid any shell interpolation of `cmd`. */
export function hasCommand(cmd: string): boolean {
  try {
    const r = execaSync("sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", cmd], {
      reject: false,
      stdio: "pipe",
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * macOS watcher: polls `osascript` (NSPasteboard via AppleScript) every ~1 s.
 * osascript is a macOS built-in — no install required. Writes atomically
 * (tmp → rename); removes the bridge file when clipboard transitions away from
 * an image so the container-side shim's `-f` check doubles as a "has image"
 * signal. osascript exits non-zero when the clipboard holds no PNG, so the
 * `else` branch handles both "no image" and "osascript error" uniformly.
 *
 * Invocation: `bash -c "$MACOS_WATCHER_SCRIPT" ccairgap-clipboard-watcher <bridge-path>`
 */
export const MACOS_WATCHER_SCRIPT = `
set -u
BRIDGE="$1"
BRIDGE_DIR="$(dirname "$BRIDGE")"
mkdir -p "$BRIDGE_DIR"
while :; do
    TMP="$(mktemp "\${BRIDGE}.tmp.XXXXXX")"
    if osascript -e 'set png_data to (the clipboard as \u00ABclass PNGf\u00BB)' -e "set fp to open for access POSIX file \\"$TMP\\" with write permission" -e 'write png_data to fp' -e 'close access fp' 2>/dev/null && [ -s "$TMP" ]; then
        mv "$TMP" "$BRIDGE"
    else
        rm -f "$TMP" "$BRIDGE" 2>/dev/null || true
    fi
    # Defensive: if mv failed (e.g. disk full), the tmp file lingers. No-op on
    # the happy path since mv already moved it.
    rm -f "$TMP" 2>/dev/null || true
    sleep 1
done
`;

/**
 * Wayland / WSL2 watcher: event-driven via \`wl-paste --watch\`, which re-runs
 * the inner shell on every clipboard change. The inner shell lists available
 * MIME types and picks the first \`image/*\` it finds (png OR bmp — Claude Code
 * auto-converts BMP → PNG via Sharp, so any image format works). Writes
 * atomically; clears the bridge on non-image content.
 *
 * Invocation: \`bash -c "$WAYLAND_WATCHER_SCRIPT" ccairgap-clipboard-watcher <bridge-path>\`
 */
export const WAYLAND_WATCHER_SCRIPT = `
set -u
BRIDGE="$1"
BRIDGE_DIR="$(dirname "$BRIDGE")"
mkdir -p "$BRIDGE_DIR"
exec wl-paste --watch sh -c '
    BRIDGE="$0"
    TMP="$(mktemp "\${BRIDGE}.tmp.XXXXXX")"
    MIME="$(wl-paste -l 2>/dev/null | grep -E "^image/(png|bmp|jpeg|jpg|gif|webp)$" | head -n1)"
    if [ -n "$MIME" ] && wl-paste --type "$MIME" 2>/dev/null > "$TMP" && [ -s "$TMP" ]; then
        mv "$TMP" "$BRIDGE"
    else
        rm -f "$TMP" "$BRIDGE" 2>/dev/null || true
    fi
    # Defensive tmp cleanup for mv failures.
    rm -f "$TMP" 2>/dev/null || true
' "$BRIDGE"
`;

/**
 * X11 watcher: polls \`xclip\` every ~1 s. Tries image/png first, then
 * image/bmp as a fallback for Windows-origin clipboards mirrored via wine /
 * VNC / tmux clipboard bridges.
 *
 * Invocation: \`bash -c "$X11_WATCHER_SCRIPT" ccairgap-clipboard-watcher <bridge-path>\`
 */
export const X11_WATCHER_SCRIPT = `
set -u
BRIDGE="$1"
BRIDGE_DIR="$(dirname "$BRIDGE")"
mkdir -p "$BRIDGE_DIR"
while :; do
    TMP="$(mktemp "\${BRIDGE}.tmp.XXXXXX")"
    if xclip -selection clipboard -t image/png -o 2>/dev/null > "$TMP" && [ -s "$TMP" ]; then
        mv "$TMP" "$BRIDGE"
    elif xclip -selection clipboard -t image/bmp -o 2>/dev/null > "$TMP" && [ -s "$TMP" ]; then
        mv "$TMP" "$BRIDGE"
    else
        rm -f "$TMP" "$BRIDGE" 2>/dev/null || true
    fi
    # Defensive tmp cleanup for mv failures.
    rm -f "$TMP" 2>/dev/null || true
    sleep 1
done
`;

function scriptForMode(mode: Exclude<ClipboardMode, "none">): string {
  switch (mode) {
    case "macos": return MACOS_WATCHER_SCRIPT;
    case "wayland":
    case "wsl2": return WAYLAND_WATCHER_SCRIPT;
    case "x11": return X11_WATCHER_SCRIPT;
  }
}

export interface StartWatcherResult {
  bridgePath: string;
  /** Kill the watcher with SIGTERM → 500 ms grace → SIGKILL. Idempotent. Async. */
  cleanup: () => Promise<void>;
}

/**
 * Spawn the per-platform watcher. Returns \`null\` if the watcher exits within
 * 200 ms (startup-failure probe — missing binary, permission, etc.). On
 * unexpected mid-session exit, the child's \`exit\` handler removes the bridge
 * file and logs a one-line stderr warning so Claude Code doesn't paste a
 * stale image.
 */
export async function startHostWatcher(
  mode: Exclude<ClipboardMode, "none">,
  sessionDir: string,
): Promise<StartWatcherResult | null> {
  const bridgeDir = join(sessionDir, "clipboard-bridge");
  const bridgePath = join(bridgeDir, "current.png");
  try {
    mkdirSync(bridgeDir, { recursive: true });
  } catch (e) {
    console.error(`ccairgap: clipboard bridge dir could not be created: ${(e as Error).message}`);
    return null;
  }

  const script = scriptForMode(mode);
  const child: ChildProcess = spawn(
    "bash",
    ["-c", script, "ccairgap-clipboard-watcher", bridgePath],
    { stdio: ["ignore", "ignore", "pipe"], detached: false },
  );

  // Attach stderr collector at spawn. Attaching AFTER the child exits is racy
  // — Node may drop already-emitted bytes if the pipe was drained. The
  // install-hint diagnostic for a missing tool depends on capturing real
  // stderr.
  let stderrBuf = "";
  child.stderr?.on("data", (b) => (stderrBuf += b.toString()));

  // Startup probe: 200 ms. Use a named handler so we can `off()` it on
  // success — otherwise the stray listener double-fires with the mid-session
  // handler when the child eventually exits.
  let probeResolve: (v: boolean) => void = () => {};
  const probePromise = new Promise<boolean>((res) => { probeResolve = res; });
  const onProbeExit = (code: number | null, signal: NodeJS.Signals | null) => {
    probeResolve(code !== null || signal !== null);
  };
  child.once("exit", onProbeExit);
  const startupTimer = setTimeout(() => {
    child.off("exit", onProbeExit);
    probeResolve(false);
  }, 200);

  const startupFailed = await probePromise;
  clearTimeout(startupTimer);

  if (startupFailed) {
    // Small grace for late stderr drain.
    await new Promise((r) => setTimeout(r, 50));
    console.error(
      `ccairgap: clipboard watcher failed to start: ${stderrBuf.trim() || "exited immediately"}`,
    );
    return null;
  }

  // Mid-session exit handler. `intentionalExit` suppresses the log for our
  // own cleanup() path.
  //
  // SIGTERM/SIGINT/SIGHUP also suppress the log: when the user Ctrl-Cs the
  // CLI, the watcher is in the same process group and receives SIGINT
  // simultaneously, typically BEFORE cleanup() runs. That's the normal exit
  // path, not a crash. Only an unsignaled non-zero exit (or a genuine crash
  // signal like SIGSEGV) is noteworthy.
  let intentionalExit = false;
  child.on("exit", (code, signal) => {
    try { rmSync(bridgePath, { force: true }); } catch { /* best-effort */ }
    if (intentionalExit) return;
    if (signal === "SIGTERM" || signal === "SIGINT" || signal === "SIGHUP") return;
    console.error(
      `ccairgap: clipboard watcher exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"}). ` +
        `Paste disabled for the rest of the session.`,
    );
  });

  return {
    bridgePath,
    cleanup: async () => {
      intentionalExit = true;
      if (child.killed || child.exitCode !== null) return;

      child.kill("SIGTERM");

      // Grace period: wait up to 500 ms for graceful exit, then SIGKILL.
      const exited = await new Promise<boolean>((res) => {
        const timer = setTimeout(() => res(false), 500);
        child.once("exit", () => {
          clearTimeout(timer);
          res(true);
        });
      });

      if (!exited) {
        try {
          child.kill("SIGKILL");
        } catch {
          // already dead
        }
        // Brief await so the kernel reaps the child before launch.ts's handoff
        // starts tearing down $SESSION.
        await new Promise((r) => setTimeout(r, 50));
      }
    },
  };
}

export interface SetupInput {
  enabled: boolean;
}

export interface SetupResult {
  mode: ClipboardMode;
  mounts: Mount[];
  envVars: Record<string, string>;
  cleanup: () => Promise<void>;
}

/**
 * Top-level orchestration called by \`launch.ts\`. Detects mode, logs any
 * install-hint warning, spawns the watcher, returns the mount + env payload
 * for \`docker run\`. The returned \`cleanup\` is always safe to \`await\` —
 * no-op when mode is "none".
 */
export async function detectAndSetupClipboardBridge(
  sessionDir: string,
  i: SetupInput,
): Promise<SetupResult> {
  const noop: SetupResult = { mode: "none", mounts: [], envVars: {}, cleanup: async () => {} };
  if (!i.enabled) return noop;

  const { mode, warning } = detectClipboardMode({
    platform: process.platform,
    env: process.env,
    isWsl2,
    hasCommand,
  });

  if (warning) console.error(warning);
  if (mode === "none") return noop;

  const started = await startHostWatcher(mode, sessionDir);
  if (!started) {
    try {
      rmSync(join(sessionDir, "clipboard-bridge"), { recursive: true, force: true });
    } catch {
      // best-effort
    }
    return noop;
  }

  return {
    mode,
    mounts: buildClipboardMounts(mode, sessionDir),
    envVars: buildClipboardEnvVars(mode),
    cleanup: started.cleanup,
  };
}
