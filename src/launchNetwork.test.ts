import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execaSync } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { hashToken, type NetworkConfig } from "./network.js";

const refresh = vi.hoisted(() => ({
  inputs: [] as Array<{
    sessionDir: string;
    networkPolicy?: boolean;
    onHostDrivenWrite?: (json: string) => void;
  }>,
  after: undefined as string | undefined,
}));

// Runs the callback at start, because the session dir is gone once launch returns.
vi.mock("./runtimeAuthRefresh.js", () => ({
  startRuntimeAuthRefresh: (input: (typeof refresh.inputs)[number]) => {
    refresh.inputs.push(input);
    if (input.onHostDrivenWrite) {
      input.onHostDrivenWrite('{"claudeAiOauth":{"accessToken":"rotated"}}');
      refresh.after = readFileSync(
        join(input.sessionDir, "network", "sidecar", "credentials", "api.anthropic.com"),
        "utf8",
      );
    }
    return { stop: async () => undefined };
  },
}));

const { launch } = await import("./launch.js");

const POLICY: NetworkConfig = { agentPreset: true, checkCredentials: true, rules: [] };

describe("launch with a network policy", () => {
  let root: string;
  let state: string;
  let home: string;
  let repo: string;
  let log: string;
  let saved: string;
  let savedEnv: Record<string, string | undefined>;
  let errorSpy: MockInstance<(...args: unknown[]) => void>;
  let exitSpy: MockInstance;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "airgap-net-launch-")));
    state = join(root, "state");
    home = join(root, "home");
    repo = join(root, "repo");
    log = join(root, "docker.log");
    saved = join(root, "sidecar-at-start");
    const bin = join(root, "bin");
    for (const d of [state, join(home, ".claude"), repo, bin]) mkdirSync(d, { recursive: true });
    execaSync("git", ["init", "-q"], { cwd: repo });
    execaSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"], { cwd: repo });
    // Answers like docker, and saves the session files when the sidecar starts.
    writeFileSync(
      join(bin, "docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$1 $2" in
  "run -d")
    [ -n "$FAKE_DOCKER_FAIL_RUN" ] && exit 1
    for a in "$@"; do
      case "$a" in *:/ccairgap:ro) cp -R "\${a%%:/ccairgap:ro}" "${saved}" ;; esac
    done
    ;;
  exec*)
    case "$*" in *" cat "*) printf '%s\\n' '-----BEGIN CERTIFICATE-----' ;; esac
    ;;
  inspect*) echo true ;;
  run*)
    case "$*" in
      *"codex --version"*) echo "codex-cli 0.134.0" ;;
      *"claude --version"*) echo "2.1.143 (Claude Code)" ;;
      *CCAIRGAP_NAME=*)
        for a in "$@"; do
          case "$a" in
            *:/host-claude/.credentials.json:ro)
              src="\${a%%:/host-claude/.credentials.json:ro}"
              ls -l "$src" | cut -c1-10 > "${root}/mask-mode"
              wc -c < "$src" | tr -d ' ' > "${root}/mask-size"
              ;;
          esac
        done
        ;;
    esac
    ;;
esac
exit 0
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    writeFileSync(
      join(bin, "security"),
      `#!/bin/sh\nprintf '%s' '{"claudeAiOauth":{"accessToken":"session-token"}}'\n`,
    );
    chmodSync(join(bin, "security"), 0o755);
    writeFileSync(join(home, ".claude", ".credentials.json"), '{"claudeAiOauth":{"accessToken":"session-token"}}');
    writeFileSync(join(home, ".claude.json"), "{}");
    savedEnv = {};
    for (const k of ["CCAIRGAP_HOME", "HOME", "PATH", "NODE_EXTRA_CA_CERTS", "CODEX_API_KEY", "CODEX_HOME", "FAKE_DOCKER_FAIL_RUN"]) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    process.env.CCAIRGAP_HOME = state;
    process.env.HOME = home;
    process.env.PATH = `${bin}:${savedEnv.PATH ?? ""}`;
    refresh.inputs = [];
    refresh.after = undefined;
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(root, { recursive: true, force: true });
  });

  function run(extra: Record<string, unknown> = {}) {
    return launch({
      repos: [repo],
      ros: [],
      cp: [],
      sync: [],
      mount: [],
      keepContainer: false,
      dockerBuildArgs: { CLAUDE_CODE_VERSION: "2.1.143", CODEX_VERSION: "0.134.0" },
      rebuild: false,
      hookEnable: [],
      mcpEnable: [],
      dockerRunArgs: [],
      warnDockerArgs: false,
      bare: false,
      clipboard: false,
      noPreserveDirty: false,
      claudeArgs: [],
      noAutoMemory: false,
      refreshBelowTtlMinutes: 0,
      network: POLICY,
      ...extra,
    } as Parameters<typeof launch>[0]);
  }

  const lines = (): string[] => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const agentRun = (): string | undefined => lines().find((l) => l.startsWith("run ") && l.includes("CCAIRGAP_NAME="));
  const stderrText = (): string => errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
  const sessions = (): string[] => (existsSync(join(state, "sessions")) ? readdirSync(join(state, "sessions")) : []);
  const policyAtStart = () => JSON.parse(readFileSync(join(saved, "policy.json"), "utf8")) as {
    rules: Array<{ host: string }>;
    credentialHosts: string[];
  };

  describe("host credentials mask", () => {
    it("mounts an empty read-only file over the host credentials file", async () => {
      await run({ network: undefined });
      expect(agentRun()).toContain(":/host-claude/.credentials.json:ro");
      expect(readFileSync(join(root, "mask-mode"), "utf8").trim()).toBe("-r--r--r--");
      expect(readFileSync(join(root, "mask-size"), "utf8").trim()).toBe("0");
    });

    it("adds no mask when the target is outside the config dir", async () => {
      const outside = join(root, "outside.json");
      writeFileSync(outside, readFileSync(join(home, ".claude", ".credentials.json")));
      rmSync(join(home, ".claude", ".credentials.json"));
      symlinkSync(outside, join(home, ".claude", ".credentials.json"));
      await run({ network: undefined });
      expect(agentRun()).toBeDefined();
      expect(agentRun()).not.toContain("/host-claude/.credentials.json");
    });
  });

  it("runs the agent with no network, the proxy env, and the policy-only mounts", async () => {
    const result = await run();
    const agent = agentRun()!;
    expect(agent).toContain("--network none");
    expect(agent).toContain(`ccairgap-${result.id}-network:/run/ccairgap-network/sock:ro`);
    expect(agent).toContain(":/run/ccairgap-network/agent:ro");
    expect(agent).toContain("-e CCAIRGAP_NETWORK_POLICY=1");
    expect(agent).toContain("-e HTTPS_PROXY=http://127.0.0.1:3128");
    expect(agent).not.toContain("network/sidecar");
  });

  it("adds no network arguments without a policy", async () => {
    await run({ network: undefined });
    const agent = agentRun()!;
    expect(agent).not.toContain("--network");
    expect(agent).not.toContain("CCAIRGAP_NETWORK_POLICY");
    expect(lines().some((l) => l.startsWith("run -d"))).toBe(false);
    expect(refresh.inputs[0]!.onHostDrivenWrite).toBeUndefined();
    expect(refresh.inputs[0]!.networkPolicy).toBe(false);
  });

  it("prints the policy before the session starts", async () => {
    await run();
    expect(stderrText()).toContain("network policy active");
    expect(stderrText()).toContain("preset: allow api.anthropic.com:443");
  });

  it("starts the sidecar before the agent, and removes it afterwards", async () => {
    const result = await run();
    const all = lines();
    const name = `ccairgap-${result.id}-network`;
    const start = all.findIndex((l) => l.startsWith("run -d"));
    const agent = all.findIndex((l) => l.startsWith("run ") && l.includes("CCAIRGAP_NAME="));
    const remove = all.findIndex((l) => l === `rm -f -v ${name}`);
    expect(start).toBeGreaterThan(-1);
    expect(agent).toBeGreaterThan(start);
    expect(remove).toBeGreaterThan(agent);
    expect(all).toContain(`volume rm ${name}`);
  });

  it("records the session token and the hash of a host-driven refresh", async () => {
    await run();
    const stored = readFileSync(join(saved, "credentials", "api.anthropic.com"), "utf8");
    expect(stored).toContain(hashToken("session-token"));
    expect(refresh.inputs[0]!.networkPolicy).toBe(true);
    expect(refresh.after).toContain(hashToken("rotated"));
  });

  it("selects the Codex API-key preset and hash in print mode", async () => {
    process.env.CODEX_API_KEY = "codex-key";
    await run({ agent: "codex", print: "hello" });
    expect(policyAtStart().rules.map((r) => r.host)).toEqual(["api.openai.com"]);
    expect(readFileSync(join(saved, "credentials", "api.openai.com"), "utf8")).toContain(hashToken("codex-key"));
  });

  it("selects the ChatGPT preset and hash for a Codex token", async () => {
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome);
    process.env.CODEX_HOME = codexHome;
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: { access_token: "codex-access", id_token: "i", account_id: "a", refresh_token: "r" },
        last_refresh: new Date().toISOString(),
      }),
    );
    await run({ agent: "codex" });
    expect(policyAtStart().rules.map((r) => r.host)).toEqual(["chatgpt.com"]);
    expect(readFileSync(join(saved, "credentials", "chatgpt.com"), "utf8")).toContain(hashToken("codex-access"));
  });

  it("does not forward NODE_EXTRA_CA_CERTS", async () => {
    const ca = join(root, "corp.pem");
    writeFileSync(ca, "x");
    process.env.NODE_EXTRA_CA_CERTS = ca;
    await run();
    expect(stderrText()).toContain("NODE_EXTRA_CA_CERTS is not forwarded");
    expect(agentRun()).not.toContain("corp.pem");
  });

  it("stops and removes the session when the sidecar fails to start", async () => {
    process.env.FAKE_DOCKER_FAIL_RUN = "1";
    await expect(run()).rejects.toThrow("exit 1");
    expect(stderrText()).toContain("failed to start the network sidecar");
    expect(agentRun()).toBeUndefined();
    expect(sessions()).toEqual([]);
  });

  it("rejects a conflicting docker arg before any side effect", async () => {
    await expect(run({ dockerRunArgs: ["--network host"] })).rejects.toThrow("exit 1");
    expect(stderrText()).toContain("--docker-run-arg conflicts with the network policy: --network");
    expect(sessions()).toEqual([]);
    expect(lines().some((l) => l.startsWith("run "))).toBe(false);
  });

  it("rejects --ro over a Docker socket directory", async () => {
    await expect(run({ ros: ["/var/run"] })).rejects.toThrow("exit 1");
    expect(stderrText()).toContain("--ro or --mount path conflicts with the network policy");
    expect(lines().some((l) => l.startsWith("run "))).toBe(false);
    expect(sessions()).toEqual([]);
  });
});
