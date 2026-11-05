import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const docker = vi.hoisted(() => ({
  calls: [] as string[][],
  options: [] as unknown[],
  fail: new Set<string>(),
  outputs: new Map<string, string>(),
  waitResolve: undefined as (() => void) | undefined,
}));

function respond(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const key = args.slice(0, 2).join(" ");
  const fails = docker.fail.has(key) || docker.fail.has(args[0]!);
  return { exitCode: fails ? 1 : 0, stdout: docker.outputs.get(key) ?? docker.outputs.get(args[0]!) ?? "", stderr: "" };
}

vi.mock("execa", () => ({
  execa: (_file: string, args: string[], options?: { reject?: boolean }) => {
    docker.calls.push(args);
    docker.options.push(options);
    if (args[0] === "wait") {
      const promise = new Promise((resolve) => {
        docker.waitResolve = () => resolve({ exitCode: 0 });
      }) as Promise<unknown> & { kill: () => void };
      promise.kill = () => undefined;
      return promise;
    }
    const result = respond(args);
    if (result.exitCode !== 0 && options?.reject !== false) return Promise.reject(new Error(`failed: ${args[0]}`));
    return Promise.resolve(result);
  },
  execaSync: (_file: string, args: string[]) => {
    docker.calls.push(args);
    return respond(args);
  },
}));

const { removeLeftoverNetworkResources, startNetworkSidecar } = await import("./network.js");

const CA = "-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----";
const PLAN = { rules: [{ action: "allow" as const, host: "a.test", ports: [443] }], userRuleCount: 1, credentialHosts: [] };
const NAME = "ccairgap-s1-network";

let dir: string;
let stderr: string[];

function ran(...prefix: string[]): boolean {
  return docker.calls.some((c) => prefix.every((p, i) => c[i] === p));
}

function start(): ReturnType<typeof startNetworkSidecar> {
  return startNetworkSidecar({ id: "s1", sessionDir: dir, plan: PLAN });
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ccairgap-life-"));
  docker.calls = [];
  docker.options = [];
  docker.fail = new Set();
  docker.outputs = new Map([
    ["exec", CA],
    ["inspect -f", "true"],
  ]);
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((line: string) => {
    stderr.push(line);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("startNetworkSidecar", () => {
  it("writes the session files, and keeps the policy out of the agent directory", async () => {
    const handle = await start();
    const sidecar = join(dir, "network", "sidecar");
    const agent = join(dir, "network", "agent");
    expect(readdirSync(sidecar).sort()).toEqual(["credentials", "policy.json", "policy.py", "relay.py"]);
    expect(readdirSync(agent).sort()).toEqual(["ca.pem", "forwarder.mjs"]);
    expect(JSON.parse(readFileSync(join(sidecar, "policy.json"), "utf8"))).toEqual({
      rules: PLAN.rules,
      credentialHosts: [],
    });
    await handle.stop({ keepContainer: false });
  });

  it("copies the certificate file only, and makes it readable", async () => {
    const handle = await start();
    expect(docker.calls).toContainEqual(["exec", NAME, "cat", "/ca/mitmproxy-ca-cert.pem"]);
    const ca = join(dir, "network", "agent", "ca.pem");
    expect(readFileSync(ca, "utf8")).toBe(`${CA}\n`);
    expect(statSync(ca).mode & 0o777).toBe(0o644);
    await handle.stop({ keepContainer: false });
  });

  it("removes the sidecar and volume when the output is not a certificate", async () => {
    docker.outputs.set("exec", "-----BEGIN PRIVATE KEY-----");
    await expect(start()).rejects.toThrow(/invalid CA certificate/);
    expect(ran("rm", "-f", "-v", NAME)).toBe(true);
    expect(ran("volume", "rm", NAME)).toBe(true);
    expect(existsSync(join(dir, "network", "agent", "ca.pem"))).toBe(false);
  });

  it("removes the sidecar and volume when docker run fails", async () => {
    docker.fail.add("run -d");
    await expect(start()).rejects.toThrow(/failed: run/);
    expect(ran("rm", "-f", "-v", NAME)).toBe(true);
    expect(ran("volume", "rm", NAME)).toBe(true);
  });

  it("reports the sidecar log when the sidecar exits during startup", async () => {
    docker.fail.add("exec");
    docker.outputs.set("inspect -f", "false");
    docker.outputs.set("logs --tail", "bad addon");
    await expect(start()).rejects.toThrow(/sidecar exited during startup: bad addon/);
  });

  it("sends pull progress to stderr, because stdout belongs to a print-mode agent", async () => {
    docker.fail.add("image inspect");
    const handle = await start();
    const index = docker.calls.findIndex((c) => c[0] === "pull");
    expect(docker.options[index]).toEqual({ stdio: ["ignore", 2, 2] });
    await handle.stop({ keepContainer: false });
  });

  it("warns when the sidecar stops during the session", async () => {
    const handle = await start();
    docker.waitResolve!();
    await flush();
    expect(stderr.join("\n")).toContain("the network sidecar stopped");
    await handle.stop({ keepContainer: false });
  });
});

describe("stop", () => {
  it("prints the denial summary, removes both resources, and does not warn", async () => {
    const handle = await start();
    docker.outputs.set("logs", JSON.stringify({ verdict: "deny", why: "w", host: "h.test" }));
    await handle.stop({ keepContainer: false });
    docker.waitResolve!();
    await flush();
    const text = stderr.join("\n");
    expect(text).toContain("network policy denied 1 requests");
    expect(text).toContain("1x h.test (w)");
    expect(text).not.toContain("the network sidecar stopped");
    expect(ran("rm", "-f", "-v", NAME)).toBe(true);
    expect(ran("volume", "rm", NAME)).toBe(true);
  });

  it("prints no summary when nothing was denied", async () => {
    const handle = await start();
    await handle.stop({ keepContainer: false });
    expect(stderr.join("\n")).not.toContain("network policy denied");
  });

  it("names the command when --keep-container holds the volume", async () => {
    const handle = await start();
    docker.fail.add("volume rm");
    await handle.stop({ keepContainer: true });
    expect(stderr.join("\n")).toContain(
      `docker rm ccairgap-s1 && docker volume rm ${NAME}`,
    );
  }, 10_000);

  it("adds no signal handlers, because the launch handler stops the agent first", async () => {
    const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
    const before = signals.map((s) => process.listenerCount(s));
    const handle = await start();
    expect(signals.map((s) => process.listenerCount(s))).toEqual(before);
    await handle.stop({ keepContainer: false });
  });
});

describe("removeLeftoverNetworkResources", () => {
  it("removes the sidecar with its anonymous volume, then the named volume", () => {
    removeLeftoverNetworkResources("s1");
    expect(ran("rm", "-f", "-v", NAME)).toBe(true);
    expect(ran("volume", "rm", NAME)).toBe(true);
    expect(stderr).toEqual([]);
  });

  it("stays silent when no volume exists", () => {
    docker.fail.add("volume inspect");
    removeLeftoverNetworkResources("s1");
    expect(ran("volume", "rm", NAME)).toBe(false);
    expect(stderr).toEqual([]);
  });

  it("names the command when the agent container holds the volume", () => {
    docker.fail.add("volume rm");
    removeLeftoverNetworkResources("s1");
    expect(stderr.join("\n")).toContain(`docker rm -f ccairgap-s1 && docker volume rm ${NAME}`);
  });
});
