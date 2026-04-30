import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DOCKERFILE = readFileSync(
  join(__dirname, "..", "docker", "Dockerfile"),
  "utf8",
);

describe("docker/Dockerfile clipboard invariants", () => {
  it("does NOT install xclip", () => {
    // xclip in the container breaks v2 clipboard passthrough: Claude Code
    // tries xclip before wl-paste, so if xclip exists Claude will use it
    // instead of our fake wl-paste shim. See docs/SPEC.md §"Clipboard passthrough".
    expect(DOCKERFILE).not.toMatch(/\bxclip\b/);
  });

  it("does NOT install wl-clipboard", () => {
    // Same reasoning: a real wl-paste would attempt to contact a Wayland
    // compositor that isn't mounted, breaking the shim-override.
    expect(DOCKERFILE).not.toMatch(/\bwl-clipboard\b/);
  });

  it("pre-creates /run/ccairgap-clipboard world-writable", () => {
    // Container runs as the host UID via `docker run --user`; the bridge
    // dir's host-source already has the correct ownership when mounted, so
    // the in-image dir only matters when clipboard mode is off (nothing
    // reads/writes there). 1777 keeps the no-op path side-effect-free.
    expect(DOCKERFILE).toMatch(/mkdir -p \/run\/ccairgap-clipboard/);
    expect(DOCKERFILE).toMatch(/chmod 1777 \/run\/ccairgap-clipboard/);
  });
});

describe("docker/Dockerfile UID-portability invariants", () => {
  it("does NOT bake host UID/GID as build args", () => {
    // Published image is UID-portable: fixed build-time UID 1000, runtime
    // override via `docker run --user`. HOST_UID/HOST_GID build args would
    // re-introduce per-host image divergence and defeat the shared-image
    // cache. See docs/SPEC.md §"Container UID portability".
    expect(DOCKERFILE).not.toMatch(/\bARG HOST_UID\b/);
    expect(DOCKERFILE).not.toMatch(/\bARG HOST_GID\b/);
  });

  it("does NOT install gosu (no runtime privilege drop in current model)", () => {
    // Earlier UID-fixup-via-usermod design needed gosu. Current model
    // launches the container directly as the host UID, so no drop step
    // exists; gosu would be dead weight (and a misleading hint about how
    // privilege is handled).
    expect(DOCKERFILE).not.toMatch(/\bgosu\b/);
  });

  it("makes /home/claude writable for any runtime UID", () => {
    // The CLI passes --user $(id -u):$(id -g); /home/claude is owned by
    // the baked UID 1000 but must be writable by any UID. `go+rwX` adds
    // rwx for dirs / rw for files (executable bit preserved by capital X).
    expect(DOCKERFILE).toMatch(/chmod -R go\+rwX \/home\/claude/);
  });

  it("installs python3 + pip + venv (common user tooling)", () => {
    expect(DOCKERFILE).toMatch(/\bpython3\b/);
    expect(DOCKERFILE).toMatch(/\bpython3-pip\b/);
    expect(DOCKERFILE).toMatch(/\bpython3-venv\b/);
  });
});

describe("docker/Dockerfile managed-policy invariants", () => {
  it("does NOT create anything under /etc/claude-code/", () => {
    // /etc/claude-code is the reserved container path for the host managed-
    // policy RO bind-mount (src/mounts.ts `managed-policy` case). If the base
    // image ever bakes files under that path, our mount would silently
    // overmount them — drifting from the documented invariant that the
    // managed-policy mount is the only source of truth for that dir.
    expect(DOCKERFILE).not.toMatch(/\/etc\/claude-code\b/);
  });
});
