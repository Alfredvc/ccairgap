# Clipboard passthrough

ccairgap runs a host-side watcher alongside the container. When you copy an image on the host, the watcher writes it to a bridge directory that's RO-mounted at `/run/ccairgap-clipboard/` inside the container. Claude Code's paste handler reads from there, so Ctrl+V / paste works as on the host.

## Platform support

| Host platform | Tool used | Install required |
|---------------|-----------|------------------|
| macOS | `osascript` (built-in) | no |
| Linux Wayland | `wl-paste` from `wl-clipboard` | yes |
| Linux X11 | `xclip` | yes |
| WSL2 | `wl-paste` from `wl-clipboard` | yes |
| Windows (non-WSL2) | — | unsupported |

If the required tool is missing, ccairgap prints an install hint and continues without passthrough. No hard fail.

## Opt out

`--no-clipboard` on the CLI or `clipboard: false` in config. No-op under `--print` (non-interactive, no paste events anyway).

## How it works

Host-side watcher (osascript on macOS; wl-paste/xclip on Linux) is spawned as a child of the CLI process with `detached: false`, so Ctrl-C and SIGKILL of the CLI kill the watcher automatically (same process group). Graceful cleanup uses SIGTERM → 500 ms grace → SIGKILL, awaited in the launch pipeline's `finally` block BEFORE handoff.

Mid-session watcher crash: the `child.on("exit")` handler removes the bridge file so Claude Code doesn't paste a stale image. SIGTERM/SIGINT/SIGHUP are filtered out — those mean "normal exit" and don't warrant a warning.

### Container side

The container ships no `xclip` and no `wl-clipboard`. Claude Code calls `xclip ... || wl-paste ...` — `xclip` exits 127 (command not found), the fallback runs, and our fake `wl-paste` shim in `/home/claude/.local/bin/wl-paste` serves the bridge file. Invariant: `xclip` and `wl-clipboard` must NOT end up in the container image, or the shim gets shadowed and passthrough silently breaks. Enforced by `src/dockerfileInvariants.test.ts` + a runtime stderr warning in the entrypoint.

The shim responds to:
- `wl-paste -l` / `wl-paste --list-types` → prints `image/png` if bridge file present.
- `wl-paste --type image/png` (or any `$arg == image/png`) → streams the bridge bytes. Claude Code's Sharp pipeline auto-converts BMP → PNG downstream, so the shim serves bytes as-is.

## Bridge path

Host: `$SESSION/clipboard-bridge/current.png`, written by the watcher.
Container: `/run/ccairgap-clipboard/current.png` (RO bind mount of the bridge dir).

The bridge dir is part of the session scratch — it lives with the session and dies with it.
