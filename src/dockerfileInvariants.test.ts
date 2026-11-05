import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DOCKERFILE = readFileSync(
  join(__dirname, "..", "docker", "Dockerfile"),
  "utf8",
);
const RELEASE_WORKFLOW = readFileSync(
  join(__dirname, "..", ".github", "workflows", "release.yml"),
  "utf8",
);
const RELEASE_AGENT_VERSIONS = readFileSync(
  join(__dirname, "..", "docker", "agent-versions.env"),
  "utf8",
);

describe("docker/entrypoint.sh ~/.claude copy invariants", () => {
  const ENTRYPOINT = readFileSync(
    join(__dirname, "..", "docker", "entrypoint.sh"),
    "utf8",
  );

  it("excludes top-level jobs and daemon with anchored patterns", () => {
    // Unanchored `--exclude='jobs'` also drops a nested jobs/ dir in a skill.
    expect(ENTRYPOINT).toContain("--exclude='/jobs'");
    expect(ENTRYPOINT).not.toContain("--exclude='jobs'");
    expect(ENTRYPOINT).toContain("--exclude='/daemon'");
    expect(ENTRYPOINT).not.toContain("--exclude='daemon'");
    expect(ENTRYPOINT).toContain("--exclude='/daemon.*'");
    expect(ENTRYPOINT).toContain("--exclude='/daemon-*'");
  });

  it("does not copy the user-level settings.local.json", () => {
    // Claude Code reads it as project-local settings when cwd is $HOME, and the
    // hook policy does not filter it. The anchor keeps nested files of that name.
    expect(ENTRYPOINT).toContain("--exclude='/settings.local.json'");
    expect(ENTRYPOINT).not.toContain("--exclude='settings.local.json'");
  });

  it("runs the interactive Codex branch without the shared background server", () => {
    // The image has no `ps`, and the shared app-server fails without it.
    expect(ENTRYPOINT).toContain(
      'FINAL_CMD=(codex --dangerously-bypass-approvals-and-sandbox --no-daemon --cd "$CWD" "$@")',
    );
  });

  it("starts the network forwarder before any command can run", () => {
    // A client that runs before the forwarder listens fails, and exec and test
    // modes must get the same network as agent mode.
    const forwarder = ENTRYPOINT.indexOf("forwarder.mjs");
    expect(forwarder).toBeGreaterThan(-1);
    expect(forwarder).toBeLessThan(ENTRYPOINT.indexOf('exec sh -c "$CCAIRGAP_TEST_CMD"'));
    expect(forwarder).toBeLessThan(ENTRYPOINT.indexOf('case "$ENTRYPOINT_MODE" in'));
  });

  it("tolerates rsync exits 23 and 24 in every copy block", () => {
    // Exit 24 fires when host Claude Code deletes a file during the copy.
    const tolerant = ENTRYPOINT.match(/if \[ "\$rc" -eq 23 \] \|\| \[ "\$rc" -eq 24 \]; then/g);
    expect(tolerant).toHaveLength(2);
    expect(ENTRYPOINT).not.toMatch(/if \[ "\$rc" -eq 23 \]; then/);
  });

  it("turns off agent view before the .ccairgap overlay runs", () => {
    // The overlay must run later, so `"disableAgentView": false` there opts in.
    const patch = ENTRYPOINT.indexOf(".disableAgentView = true");
    const overlay = ENTRYPOINT.indexOf("apply_ccairgap_overlay()");
    expect(patch).toBeGreaterThan(-1);
    expect(overlay).toBeGreaterThan(patch);
  });
});

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

describe("docker/Dockerfile dual-agent invariants", () => {
  it("installs Claude Code and Codex with explicit build args", () => {
    expect(DOCKERFILE).toMatch(/^ARG CLAUDE_CODE_VERSION$/m);
    expect(DOCKERFILE).toMatch(/^ARG CODEX_VERSION$/m);
    expect(DOCKERFILE).not.toMatch(/\bARG CLAUDE_CODE_VERSION=latest\b/);
    expect(DOCKERFILE).not.toMatch(/\bARG CODEX_VERSION=0\.130\.0\b/);
    expect(DOCKERFILE).toMatch(/test -n "\$CLAUDE_CODE_VERSION" && test -n "\$CODEX_VERSION"/);
    expect(DOCKERFILE).toMatch(/claude\.ai\/install\.sh \| bash -s "\$\{CLAUDE_CODE_VERSION\}"/);
    expect(DOCKERFILE).toMatch(/npm install -g @openai\/codex@\$\{CODEX_VERSION\}/);
  });

  it("copies the unified ccairgap entrypoint", () => {
    expect(DOCKERFILE).toMatch(/COPY entrypoint\.sh \/usr\/local\/bin\/ccairgap-entrypoint/);
    expect(DOCKERFILE).toMatch(/ENTRYPOINT \["\/usr\/local\/bin\/ccairgap-entrypoint"\]/);
  });

  it("pre-creates Claude and Codex bind-mount targets", () => {
    expect(DOCKERFILE).toMatch(/mkdir -p[\s\S]*\/home\/claude\/\.claude\b/);
    expect(DOCKERFILE).toMatch(/mkdir -p[\s\S]*\/home\/claude\/\.claude\/projects\b/);
    expect(DOCKERFILE).toMatch(/mkdir -p[\s\S]*\/home\/claude\/\.codex\b/);
    expect(DOCKERFILE).toMatch(/mkdir -p[\s\S]*\/home\/claude\/\.codex\/sessions\b/);
  });
});

describe("release image workflow invariants", () => {
  it("passes exact agent versions into the Docker build and identity hash", () => {
    expect(RELEASE_AGENT_VERSIONS).toMatch(/^CLAUDE_CODE_VERSION=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/m);
    expect(RELEASE_AGENT_VERSIONS).toMatch(/^CODEX_VERSION=\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/m);
    expect(RELEASE_WORKFLOW).toMatch(/docker\/agent-versions\.env/);
    expect(RELEASE_WORKFLOW).not.toMatch(/CCAIRGAP_RELEASE_CLAUDE_CODE_VERSION/);
    expect(RELEASE_WORKFLOW).not.toMatch(/CCAIRGAP_RELEASE_CODEX_VERSION/);
    expect(RELEASE_WORKFLOW).toMatch(/h\.update\(dockerfile\)/);
    expect(RELEASE_WORKFLOW).toMatch(/h\.update\(entrypoint\)/);
    expect(RELEASE_WORKFLOW).toMatch(/CLAUDE_CODE_VERSION=\$\{process\.env\.CLAUDE_CODE_VERSION\}/);
    expect(RELEASE_WORKFLOW).toMatch(/CODEX_VERSION=\$\{process\.env\.CODEX_VERSION\}/);
    expect(RELEASE_WORKFLOW).toMatch(/build-args:\s*\|\s*CLAUDE_CODE_VERSION=/);
    expect(RELEASE_WORKFLOW).toMatch(/CODEX_VERSION=\$\{\{ needs\.build\.outputs\.codex_version \}\}/);
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
