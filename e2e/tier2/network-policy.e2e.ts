import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execa } from "execa";
import {
  mkTmpHome,
  seedGitRepo,
  seedClaudeHome,
  seedHostCreds,
  runCli,
  cleanupContainers,
} from "../helpers/env";
import { dockerAvailable } from "../helpers/dockerAvailable";

const FAKE_DOCKERFILE = path.resolve("e2e/fixtures/fake.Dockerfile");
const FORCE_LINUX_PRELOAD = path.resolve("e2e/helpers/force-linux.cjs");
const PROBE = path.resolve("e2e/fixtures/network-probe.mjs");
const DIST_CLI = path.resolve("dist/cli.js");

// The fake image has its own entrypoint, so the test starts the forwarder.
function testCommand(args: string, env = ""): string[] {
  const script =
    `${env} node /run/ccairgap-network/agent/forwarder.mjs >/dev/null 2>&1 & ` +
    `sleep 1; node /ccairgap-test-probe/network-probe.mjs ${args}`;
  return [
    "--docker-run-arg=-e",
    `--docker-run-arg=CCAIRGAP_TEST_CMD='${script}'`,
    `--docker-run-arg=-v ${path.dirname(PROBE)}:/ccairgap-test-probe:ro`,
  ];
}

function results(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const match = /^([a-z_]+)=(.*)$/.exec(line.trim());
    if (match) out[match[1]!] = match[2]!;
  }
  return out;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("condition was not met before the timeout");
}

async function running(name: string): Promise<boolean> {
  const out = await execa("docker", ["ps", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], {
    reject: false,
  });
  return out.stdout.trim() === name;
}

async function anonymousVolumes(id: string): Promise<string[]> {
  const out = await execa(
    "docker",
    ["inspect", "-f", '{{range .Mounts}}{{if eq .Type "volume"}}{{.Name}} {{end}}{{end}}', `ccairgap-${id}-network`],
    { reject: false },
  );
  return out.stdout.split(/\s+/).filter((name) => name && name !== `ccairgap-${id}-network`);
}

async function volumeExists(name: string): Promise<boolean> {
  return (await execa("docker", ["volume", "inspect", name], { reject: false, stdio: "ignore" })).exitCode === 0;
}

async function networkResources(id: string): Promise<{ container: string; volume: string }> {
  const name = `ccairgap-${id}-network`;
  const container = await execa("docker", ["ps", "-a", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"], {
    reject: false,
  });
  const volume = await execa("docker", ["volume", "ls", "-q", "--filter", `name=^${name}$`], {
    reject: false,
  });
  return { container: container.stdout.trim(), volume: volume.stdout.trim() };
}

describe.skipIf(!(await dockerAvailable()))("network policy tier2", () => {
  let home: string;
  let ccairgapHome: string;
  let cleanup: () => Promise<void>;
  let repo: string;
  let shared: string;
  let env: Record<string, string>;
  let launched: string[];

  const baseArgs = () => ["--dockerfile", FAKE_DOCKERFILE, "--no-clipboard", "--print", "unused"];
  const sessionIds = () => {
    try {
      return readdirSync(path.join(ccairgapHome, "sessions"));
    } catch {
      return [];
    }
  };

  beforeEach(async () => {
    ({ home, ccairgapHome, cleanup } = await mkTmpHome());
    await seedClaudeHome(home);
    await seedHostCreds(home);
    repo = await seedGitRepo(home, "myapp");
    await mkdir(path.join(repo, ".ccairgap"));
    writeFileSync(
      path.join(repo, ".ccairgap", "config.yaml"),
      [
        "network:",
        "  rules:",
        "    - host: 169.254.169.254",
        "    - host: localhost",
        "    - action: deny",
        "      host: denied-rule.invalid",
        "      paths: ['/private/*']",
        "    - host: denied-rule.invalid",
        "",
      ].join("\n"),
    );
    // `--ro` mounts the realpath, and the macOS temp dir path holds a symlink.
    shared = realpathSync(mkdtempSync(path.join(tmpdir(), "ccairgap-net-e2e-")));
    env = {
      HOME: home,
      CCAIRGAP_HOME: ccairgapHome,
      NODE_OPTIONS: `--require ${FORCE_LINUX_PRELOAD}`,
    };
    launched = [];
  });

  afterEach(async () => {
    for (const id of [...launched, ...sessionIds()]) {
      await execa("docker", ["rm", "-f", "-v", `ccairgap-${id}-network`], { reject: false });
      await cleanupContainers(id);
      await execa("docker", ["volume", "rm", `ccairgap-${id}-network`], { reject: false });
    }
    await cleanup();
    await rm(shared, { recursive: true, force: true });
  });

  it("isolates the agent, denies each attack, summarizes, and cleans up", async () => {
    const result = await runCli([...baseArgs(), ...testCommand("attacks")], {
      env,
      cwd: repo,
      timeout: 150_000,
    });
    expect(result.stderr).toContain("network policy active");
    const r = results(result.stdout);
    expect(r).toMatchObject({
      interfaces: "lo",
      direct: "ENETUNREACH",
      socket_write: "EROFS",
      denied_host: "403",
      denied_port: "403",
      denied_path: "403",
      denied_method: "403",
      traversal: "403",
      encoded_traversal: "403",
      double_encoded: "403",
      encoded_slash: "403",
      backslash: "403",
      empty_segment: "403",
      sni_mismatch: "403",
      host_mismatch: "403",
      method_override: "403",
      http_two_label: "403",
      absolute_other_host: "403",
      lowercase_method: "403",
      body_on_get: "403",
      routing_header: "403",
      underscore_key: "403",
      bare_cr: "403",
      large_denied_body: "closed",
      deny_variant_slash: "403",
      deny_variant_case: "403",
      attacker_key: "403",
      attacker_bearer: "403",
      private_literal: "502",
      private_name: "502",
      user_deny: "403",
    });
    expect(result.stderr).toContain("network policy denied");
    expect(result.stderr).toContain("denied.invalid");
    expect(sessionIds()).toEqual([]);
    if (result.sessionId) {
      expect(await networkResources(result.sessionId)).toEqual({ container: "", volume: "" });
    }
  }, 170_000);

  it("rejects a conflicting docker arg before any side effect", async () => {
    const result = await runCli([...baseArgs(), "--docker-run-arg", "--network host"], {
      env,
      cwd: repo,
    });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("conflicts with the network policy");
    expect(sessionIds()).toEqual([]);
  }, 60_000);

  it("rejects the key in user-wide config", async () => {
    await mkdir(path.join(home, ".config", "ccairgap"), { recursive: true });
    writeFileSync(path.join(home, ".config", "ccairgap", "config.yaml"), "network: {}\n");
    const result = await runCli([...baseArgs()], { env, cwd: repo });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("'network' is not allowed in user-wide config");
    expect(sessionIds()).toEqual([]);
  }, 60_000);

  it("accepts a token after the host adds its hash during the session", async () => {
    const go = path.join(shared, "go");
    const cli = execa(
      "node",
      [
        DIST_CLI,
        ...baseArgs(),
        "--ro",
        shared,
        ...testCommand(`rotation ${go}`),
      ],
      { env: { ...process.env, ...env }, cwd: repo, reject: false, timeout: 150_000 },
    );
    await waitFor(async () => sessionIds().length === 1);
    const id = sessionIds()[0]!;
    launched.push(id);
    const sidecar = `ccairgap-${id}-network`;
    await waitFor(async () => {
      const logs = await execa("docker", ["logs", sidecar], { reject: false });
      return logs.stdout.includes('"why": "credential"');
    });
    const hash = createHash("sha256").update("rotated-token").digest("hex");
    const file = path.join(
      ccairgapHome, "sessions", id, "network", "sidecar", "credentials", "api.anthropic.com",
    );
    writeFileSync(file, `${hash}\n`);
    writeFileSync(go, "");
    const result = await cli;
    const r = results(String(result.stdout));
    expect(r.before).toBe("403");
    // The proxy forwards the request, so the status comes from the provider.
    expect(r.after).not.toBe("403");
  }, 170_000);

  it("warns when the sidecar stops, and the agent gets no bypass", async () => {
    const stop = path.join(shared, "stop");
    const cli = execa(
      "node",
      [DIST_CLI, ...baseArgs(), "--ro", shared, ...testCommand(`wait ${stop}`)],
      { env: { ...process.env, ...env }, cwd: repo, reject: false, timeout: 150_000 },
    );
    await waitFor(async () => sessionIds().length === 1);
    const id = sessionIds()[0]!;
    launched.push(id);
    await waitFor(() => running(`ccairgap-${id}`));
    await execa("docker", ["rm", "-f", `ccairgap-${id}-network`]);
    await new Promise((r) => setTimeout(r, 2_000));
    writeFileSync(stop, "");
    const result = await cli;
    expect(String(result.stderr)).toContain("the network sidecar stopped");
    expect(results(String(result.stdout)).after_stop).not.toBe("200");
  }, 170_000);

  it("removes leftovers through discard after a SIGKILL of the CLI", async () => {
    const stop = path.join(shared, "stop");
    const cli = execa(
      "node",
      [DIST_CLI, ...baseArgs(), "--ro", shared, ...testCommand(`wait ${stop}`)],
      // No pipes: the orphaned `docker run` would hold them open after the SIGKILL.
      { env: { ...process.env, ...env }, cwd: repo, reject: false, stdio: "ignore" },
    );
    await waitFor(async () => sessionIds().length === 1);
    const id = sessionIds()[0]!;
    launched.push(id);
    await waitFor(() => running(`ccairgap-${id}`));
    cli.kill("SIGKILL");
    await cli;
    await execa("docker", ["rm", "-f", `ccairgap-${id}`], { reject: false });
    expect((await networkResources(id)).container).not.toBe("");
    const anonymous = await anonymousVolumes(id);
    expect(anonymous.length).toBeGreaterThan(0);
    const discard = await runCli(["discard", id], { env, cwd: repo });
    expect(discard.exitCode).toBe(0);
    expect(await networkResources(id)).toEqual({ container: "", volume: "" });
    for (const name of anonymous) expect(await volumeExists(name)).toBe(false);
  }, 170_000);

  it("names the remedy when discard cannot remove a volume that the agent holds", async () => {
    const stop = path.join(shared, "stop");
    const cli = execa(
      "node",
      [DIST_CLI, ...baseArgs(), "--ro", shared, ...testCommand(`wait ${stop}`)],
      { env: { ...process.env, ...env }, cwd: repo, reject: false, stdio: "ignore" },
    );
    await waitFor(async () => sessionIds().length === 1);
    const id = sessionIds()[0]!;
    launched.push(id);
    await waitFor(() => running(`ccairgap-${id}`));
    cli.kill("SIGKILL");
    await cli;
    const discard = await runCli(["discard", id], { env, cwd: repo });
    expect(discard.exitCode).toBe(0);
    expect(discard.stderr).toContain(`docker rm -f ccairgap-${id} && docker volume rm ccairgap-${id}-network`);
    expect((await networkResources(id)).container).toBe("");
  }, 170_000);

  it("removes the sidecar when a signal ends the CLI", async () => {
    const stop = path.join(shared, "stop");
    const cli = execa(
      "node",
      [DIST_CLI, ...baseArgs(), "--ro", shared, ...testCommand(`wait ${stop}`)],
      { env: { ...process.env, ...env }, cwd: repo, reject: false, stdio: "ignore" },
    );
    await waitFor(async () => sessionIds().length === 1);
    const id = sessionIds()[0]!;
    launched.push(id);
    await waitFor(() => running(`ccairgap-${id}`));
    const anonymous = await anonymousVolumes(id);
    cli.kill("SIGTERM");
    const ended = await cli;
    expect(ended.signal).toBe("SIGTERM");
    expect((await networkResources(id)).container).toBe("");
    for (const name of anonymous) expect(await volumeExists(name)).toBe(false);
    // The session stays for `recover`, as for any session that a signal ends.
    expect(sessionIds()).toContain(id);
  }, 170_000);

  it("rejects mounts that expose a docker socket or session state", async () => {
    for (const args of [
      ["--docker-run-arg=-v /var/run:/x"],
      ["--docker-run-arg=--dns-option -e --privileged"],
      ["--ro", "/var/run"],
    ]) {
      const result = await runCli([...baseArgs(), ...args], { env, cwd: repo, timeout: 60_000 });
      expect(result.exitCode, `${args.join(" ")}: ${result.stderr}`).toBe(1);
      expect(result.stderr).toContain("conflicts with the network policy");
      expect(sessionIds()).toEqual([]);
    }
  }, 170_000);

  it("removes leftovers through recover after a SIGKILL of the CLI", async () => {
    const stop = path.join(shared, "stop");
    const cli = execa(
      "node",
      [DIST_CLI, ...baseArgs(), "--ro", shared, ...testCommand(`wait ${stop}`)],
      // No pipes: the orphaned `docker run` would hold them open after the SIGKILL.
      { env: { ...process.env, ...env }, cwd: repo, reject: false, stdio: "ignore" },
    );
    await waitFor(async () => sessionIds().length === 1);
    const id = sessionIds()[0]!;
    launched.push(id);
    await waitFor(() => running(`ccairgap-${id}`));
    cli.kill("SIGKILL");
    await cli;
    await execa("docker", ["rm", "-f", `ccairgap-${id}`], { reject: false });
    const recover = await runCli(["recover", id], { env, cwd: repo });
    expect(recover.exitCode).toBe(0);
    expect(await networkResources(id)).toEqual({ container: "", volume: "" });
  }, 170_000);
});
