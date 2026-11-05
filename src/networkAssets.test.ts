import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { networkAgentEnv } from "./network.js";

// Runs the relay, the forwarder and the entrypoint block for real, with only their
// fixed paths and ports replaced. Tier 2 e2e uses a fake image and skips the entrypoint.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOCKET = "/run/ccairgap-network/sock/proxy.sock";

function replaceRequired(source: string, from: string, to: string): string {
  expect(source).toContain(from);
  return source.replaceAll(from, to);
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });
}

async function until(check: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

function echoThroughTcp(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1", () => socket.write(text));
    socket.on("data", (data) => {
      resolve(data.toString());
      socket.destroy();
    });
    socket.on("error", reject);
  });
}

let dir: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  // Short, because a Unix socket path has a low length limit.
  dir = mkdtempSync(join(tmpdir(), "ccg-"));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

describe("relay and forwarder", () => {
  it("carries bytes, waits for the proxy, opens the socket, and stops with the proxy", async () => {
    const proxyPort = await freePort();
    const forwarderPort = await freePort();
    const socket = join(dir, "s.sock");
    const listening = join(dir, "listening");

    let relay = readFileSync(join(ROOT, "docker", "network", "relay.py"), "utf8");
    relay = replaceRequired(relay, SOCKET, socket);
    relay = replaceRequired(relay, '("127.0.0.1", 8080)', `("127.0.0.1", ${proxyPort})`);
    writeFileSync(join(dir, "relay.py"), relay);

    let forwarder = readFileSync(join(ROOT, "docker", "network", "forwarder.mjs"), "utf8");
    forwarder = replaceRequired(forwarder, SOCKET, socket);
    forwarder = replaceRequired(forwarder, "server.listen(3128,", `server.listen(${forwarderPort},`);
    writeFileSync(join(dir, "forwarder.mjs"), forwarder);

    // Starts listening late, so a relay that does not wait exposes its socket first.
    writeFileSync(
      join(dir, "proxy.py"),
      `
import asyncio, sys, time
time.sleep(0.5)
async def handle(reader, writer):
    data = await reader.read(100)
    if data == b"stop":
        sys.exit(0)
    writer.write(b"echo:" + data)
    await writer.drain()
    writer.close()
async def main():
    server = await asyncio.start_server(handle, "127.0.0.1", ${proxyPort})
    open(${JSON.stringify(listening)}, "w").close()
    async with server:
        await server.serve_forever()
asyncio.run(main())
`,
    );

    const relayChild = spawn("python3", ["-I", join(dir, "relay.py"), "python3", "-I", join(dir, "proxy.py")], {
      stdio: "ignore",
    });
    children.push(relayChild);
    const exited = new Promise<number | null>((resolve) => relayChild.on("exit", (code) => resolve(code)));

    await until(() => existsSync(socket));
    expect(existsSync(listening)).toBe(true);
    expect(statSync(socket).mode & 0o777).toBe(0o666);

    const forwarderChild = spawn("node", [join(dir, "forwarder.mjs")], { stdio: "ignore" });
    children.push(forwarderChild);
    let reply = "";
    for (let attempt = 0; attempt < 40 && reply === ""; attempt++) {
      reply = await echoThroughTcp(forwarderPort, "ping").catch(() => "");
      if (reply === "") await new Promise((r) => setTimeout(r, 50));
    }
    expect(reply).toBe("echo:ping");

    // A proxy that exits must stop the container, so the CLI can report it.
    await new Promise<void>((resolve) => {
      const stop = createConnection(socket, () => {
        stop.write("stop");
        stop.on("close", () => resolve());
        stop.on("error", () => resolve());
      });
    });
    await expect(exited).resolves.toBe(1);
  }, 30_000);
});

describe("entrypoint network block", () => {
  const entrypoint = readFileSync(join(ROOT, "docker", "entrypoint.sh"), "utf8");

  function block(port: number): string {
    const start = entrypoint.indexOf('if [ "${CCAIRGAP_NETWORK_POLICY:-}" = "1" ]; then');
    const end = entrypoint.indexOf("\nfi\n", start);
    expect(start).toBeGreaterThan(-1);
    let text = entrypoint.slice(start, end + 4);
    text = replaceRequired(text, "/etc/ssl/certs/ca-certificates.crt", join(dir, "system.pem"));
    text = replaceRequired(text, "/run/ccairgap-network/agent", join(dir, "agent"));
    text = replaceRequired(text, "/home/claude/", `${dir}/`);
    text = replaceRequired(text, "/dev/tcp/127.0.0.1/3128", `/dev/tcp/127.0.0.1/${port}`);
    return replaceRequired(text, "seq 1 100", "seq 1 10");
  }

  function write(port: number, forwarder: string): string {
    mkdirSync(join(dir, "agent"));
    writeFileSync(join(dir, "system.pem"), "SYSTEM\n");
    writeFileSync(join(dir, "agent", "ca.pem"), "SESSION\n");
    writeFileSync(join(dir, "agent", "forwarder.mjs"), forwarder);
    const script = join(dir, "block.sh");
    writeFileSync(script, block(port));
    return script;
  }

  function bash(script: string, env: Record<string, string>): { status: number | null; stderr: string } {
    const r = spawnSync("bash", [script], { encoding: "utf8", env: { PATH: process.env.PATH, ...env }, timeout: 20_000 });
    return { status: r.status, stderr: r.stderr };
  }

  const listener = (port: number): string =>
    `import net from "node:net"; const s = net.createServer(); s.listen(${port}, "127.0.0.1"); setTimeout(() => process.exit(0), 3000);`;

  it("builds a bundle of the system CAs and the session CA, and starts the forwarder", async () => {
    const port = await freePort();
    const script = write(port, listener(port));
    expect(bash(script, networkAgentEnv()).status).toBe(0);
    const bundle = networkAgentEnv().NODE_EXTRA_CA_CERTS!.replace("/home/claude/", `${dir}/`);
    expect(readFileSync(bundle, "utf8")).toBe("SYSTEM\nSESSION\n");
  }, 25_000);

  it("exits when the forwarder never listens, because the agent would have no network", async () => {
    const port = await freePort();
    const script = write(port, "process.exit(0);");
    const result = bash(script, { CCAIRGAP_NETWORK_POLICY: "1" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the network forwarder did not start");
  }, 25_000);

  it("does nothing without a policy", async () => {
    const port = await freePort();
    const script = write(port, "process.exit(1);");
    expect(bash(script, {}).status).toBe(0);
    expect(existsSync(join(dir, ".ccairgap-network-ca-bundle.pem"))).toBe(false);
  });

  it("listens where the agent env points", () => {
    expect(networkAgentEnv().HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(readFileSync(join(ROOT, "docker", "network", "forwarder.mjs"), "utf8")).toContain(
      'server.listen(3128, "127.0.0.1")',
    );
  });
});
