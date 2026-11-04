import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The real deep-merge filter from `apply_ccairgap_overlay` in the entrypoint. */
function mergeFilter(): string {
  const entrypoint = readFileSync(join(__dirname, "..", "docker", "entrypoint.sh"), "utf8");
  const match = /jq -s '([\s\S]*?)' "\$SETTINGS" "\$SRC\/settings\.json"/.exec(entrypoint);
  if (!match?.[1]) throw new Error("settings merge filter not found in entrypoint.sh");
  return match[1];
}

const jqAvailable = spawnSync("jq", ["--version"]).status === 0;

describe.skipIf(!jqAvailable)("entrypoint .ccairgap settings.json merge", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ccairgap-settings-merge-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const merge = (base: unknown, overlay: unknown): unknown => {
    const basePath = join(dir, "base.json");
    const overlayPath = join(dir, "overlay.json");
    writeFileSync(basePath, JSON.stringify(base));
    writeFileSync(overlayPath, JSON.stringify(overlay));
    const stdout = execFileSync("jq", ["-s", mergeFilter(), basePath, overlayPath], {
      encoding: "utf8",
    });
    return JSON.parse(stdout);
  };

  it("deep-merges objects and concatenates arrays", () => {
    expect(
      merge(
        { permissions: { allow: ["a"] }, keep: 1 },
        { permissions: { allow: ["b"], deny: ["c"] } },
      ),
    ).toEqual({ permissions: { allow: ["a", "b"], deny: ["c"] }, keep: 1 });
  });

  it("lets an overlay scalar win, including false", () => {
    expect(merge({ disableAgentView: true, model: "a" }, { disableAgentView: false, model: "b" })).toEqual({
      disableAgentView: false,
      model: "b",
    });
  });

  it("treats null in the overlay as a no-op", () => {
    expect(merge({ model: "a" }, { model: null })).toEqual({ model: "a" });
  });
});
