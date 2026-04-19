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

  it("pre-creates /run/ccairgap-clipboard with HOST ownership", () => {
    expect(DOCKERFILE).toMatch(/mkdir -p \/run\/ccairgap-clipboard/);
    expect(DOCKERFILE).toMatch(/chown \$\{HOST_UID\}:\$\{HOST_GID\} \/run\/ccairgap-clipboard/);
  });
});
