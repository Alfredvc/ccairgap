import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execaSync } from "execa";

const here = dirname(fileURLToPath(import.meta.url));
const entrypointPath = resolve(here, "..", "docker", "entrypoint.sh");
const entrypoint = readFileSync(entrypointPath, "utf8");

describe("entrypoint.sh NAME_ARGS branch", () => {
  it("builds `-n \"ccairgap $CCAIRGAP_NAME\"` when CCAIRGAP_NAME is set", () => {
    expect(entrypoint).toContain('NAME_ARGS=(-n "ccairgap $CCAIRGAP_NAME")');
  });

  it("falls back to `-n \"ccairgap\"` when CCAIRGAP_NAME is unset", () => {
    expect(entrypoint).toContain('NAME_ARGS=(-n "ccairgap")');
  });

  it("does NOT branch on CCAIRGAP_RESUME in the NAME_ARGS selector", () => {
    // Extract the NAME_ARGS assembly block. Must not skip `-n` on --resume —
    // the unified-id model uses the new session's slug regardless.
    const block = /NAME_ARGS=\(-n "ccairgap \$CCAIRGAP_NAME"\)[\s\S]*?fi/.exec(entrypoint);
    expect(block, "NAME_ARGS block not found").not.toBeNull();
    expect(block![0]).not.toMatch(/CCAIRGAP_RESUME\b/);
    expect(block![0]).not.toContain("NAME_ARGS=()");
  });
});

describe("entrypoint.sh title hook", () => {
  it("emits `[ccairgap] $CCAIRGAP_NAME` when CCAIRGAP_NAME is set, bare `[ccairgap]` otherwise", () => {
    expect(entrypoint).toContain('TITLE="[ccairgap] $CCAIRGAP_NAME"');
    expect(entrypoint).toContain('TITLE="[ccairgap]"');
  });

  it("no longer references CCAIRGAP_RESUME_ORIG_NAME", () => {
    expect(entrypoint).not.toMatch(/CCAIRGAP_RESUME_ORIG_NAME/);
  });
});

describe("entrypoint.sh behavior (executed under bash)", () => {
  // Run the two relevant branches under a real bash so regressions in quoting
  // or branch order surface as wrong output, not just wrong source text.

  /** Run a bash script with the given env and return stdout. */
  function runBash(script: string, env: Record<string, string>): string {
    const result = execaSync("bash", ["-c", script], {
      env: { PATH: process.env.PATH ?? "", ...env },
      reject: false,
    });
    if (result.exitCode !== 0) {
      throw new Error(`bash exited ${result.exitCode}: ${result.stderr}`);
    }
    return result.stdout;
  }

  const nameArgsScript = `
set -u
if [ -n "\${CCAIRGAP_NAME:-}" ]; then
    NAME_ARGS=(-n "ccairgap $CCAIRGAP_NAME")
else
    NAME_ARGS=(-n "ccairgap")
fi
printf '%s\\n' "\${NAME_ARGS[@]}"
`;

  it("NAME_ARGS with CCAIRGAP_NAME=happy-otter-1234 → [-n, 'ccairgap happy-otter-1234']", () => {
    const out = runBash(nameArgsScript, { CCAIRGAP_NAME: "happy-otter-1234" });
    expect(out.split("\n")).toEqual(["-n", "ccairgap happy-otter-1234"]);
  });

  it("NAME_ARGS with CCAIRGAP_NAME=myfeat-abcd → [-n, 'ccairgap myfeat-abcd']", () => {
    const out = runBash(nameArgsScript, { CCAIRGAP_NAME: "myfeat-abcd" });
    expect(out.split("\n")).toEqual(["-n", "ccairgap myfeat-abcd"]);
  });

  it("NAME_ARGS with CCAIRGAP_NAME unset → [-n, 'ccairgap']", () => {
    const out = runBash(nameArgsScript, {});
    expect(out.split("\n")).toEqual(["-n", "ccairgap"]);
  });

  const titleScript = `
set -u
if [ -n "\${CCAIRGAP_NAME:-}" ]; then
    TITLE="[ccairgap] $CCAIRGAP_NAME"
else
    TITLE="[ccairgap]"
fi
printf '%s' "$TITLE"
`;

  it("title with CCAIRGAP_NAME=happy-otter-1234 → '[ccairgap] happy-otter-1234'", () => {
    expect(runBash(titleScript, { CCAIRGAP_NAME: "happy-otter-1234" })).toBe("[ccairgap] happy-otter-1234");
  });

  it("title without CCAIRGAP_NAME → '[ccairgap]'", () => {
    expect(runBash(titleScript, {})).toBe("[ccairgap]");
  });
});
