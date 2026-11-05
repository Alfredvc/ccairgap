// Runs in the agent container in tier 2 network policy tests.
// Prints one `name=value` line per attempt. All attempts stay in the proxy,
// because a denied request opens no upstream connection.
import fs from "node:fs";
import net from "node:net";
import tls from "node:tls";

const proxy = { host: "127.0.0.1", port: 3128 };

function connect(host, port = 443) {
  return new Promise((resolve) => {
    const socket = net.connect(proxy, () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`);
    });
    let head = "";
    const onData = (d) => {
      head += d;
      if (head.includes("\r\n\r\n")) {
        socket.off("data", onData);
        resolve({ socket, code: head.split(" ")[1] });
      }
    };
    socket.on("data", onData);
    socket.on("error", (e) => resolve({ code: `error:${e.code}` }));
    socket.on("close", () => resolve({ code: "closed" }));
  });
}

async function tunnel(host, sni, request) {
  const c = await connect(host);
  if (c.code !== "200") {
    c.socket?.destroy();
    return `connect:${c.code}`;
  }
  return new Promise((resolve) => {
    const t = tls.connect(
      { socket: c.socket, servername: sni, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"] },
      () => t.write(request),
    );
    let out = "";
    const finish = () => {
      resolve(out.split(" ")[1] ?? "closed");
      t.destroy();
    };
    t.on("data", (d) => (out += d));
    t.on("end", finish);
    t.on("error", finish);
    t.on("close", finish);
    setTimeout(finish, 20_000);
  });
}

const get = (path, host = "api.anthropic.com", method = "GET", extra = "") =>
  `${method} ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\nContent-Length: 0\r\n${extra}\r\n`;
const A = "api.anthropic.com";

async function report(name, attempt) {
  console.log(`${name}=${await attempt()}`);
}

const mode = process.argv[2];
if (mode === "attacks") {
  const ifaces = fs.readFileSync("/proc/net/dev", "utf8").split("\n").slice(2);
  console.log(`interfaces=${ifaces.map((l) => l.split(":")[0].trim()).filter(Boolean).join(",")}`);
  await report("direct", () => new Promise((resolve) => {
    const s = net.connect(443, "1.1.1.1");
    s.on("connect", () => { s.destroy(); resolve("connected"); });
    s.on("error", (e) => resolve(e.code));
  }));
  await report("socket_write", () => {
    try {
      fs.writeFileSync("/run/ccairgap-network/sock/x", "x");
      return "written";
    } catch (e) {
      return e.code;
    }
  });
  await report("denied_host", async () => {
    const c = await connect("denied.invalid");
    c.socket?.destroy();
    return c.code;
  });
  await report("denied_port", async () => {
    const c = await connect(A, 8443);
    c.socket?.destroy();
    return c.code;
  });
  await report("denied_path", () => tunnel(A, A, get("/v1/files")));
  await report("denied_method", () => tunnel(A, A, get("/v1/messages", A, "DELETE")));
  await report("traversal", () => tunnel(A, A, get("/v1/messages/../files")));
  await report("encoded_traversal", () => tunnel(A, A, get("/v1/messages/%2e%2e/files")));
  await report("double_encoded", () => tunnel(A, A, get("/v1/messages/%252e%252e/files")));
  await report("encoded_slash", () => tunnel(A, A, get("/v1/messages/..%2ffiles")));
  await report("backslash", () => tunnel(A, A, get("/v1/messages/..\\files")));
  await report("empty_segment", () => tunnel(A, A, get("//v1/messages")));
  await report("sni_mismatch", () => tunnel(A, "denied.invalid", get("/v1/messages")));
  await report("host_mismatch", () => tunnel(A, A, get("/v1/messages", "denied.invalid")));
  await report("method_override", () =>
    tunnel(A, A, get("/v1/messages", A, "GET", "X-HTTP-Method-Override: DELETE\r\n")));
  await report("attacker_key", () =>
    tunnel(A, A, get("/v1/messages", A, "POST", "x-api-key: sk-attacker\r\n")));
  await report("attacker_bearer", () =>
    tunnel(A, A, get("/v1/messages", A, "POST", "Authorization: Bearer attacker\r\n")));
  await report("http_two_label", () =>
    tunnel(A, A, `GET https://${A}/v1/messages HTTP/2.0\r\nHost: denied.invalid\r\n\r\n`));
  await report("absolute_other_host", () =>
    tunnel(A, A, `GET https://denied.invalid/v1/messages HTTP/1.1\r\nHost: ${A}\r\nConnection: close\r\n\r\n`));
  await report("lowercase_method", () =>
    tunnel(A, A, `get /v1/messages HTTP/1.1\r\nHost: ${A}\r\nConnection: close\r\n\r\n`));
  await report("body_on_get", () =>
    tunnel(A, A, `GET /v1/messages HTTP/1.1\r\nHost: ${A}\r\nConnection: close\r\nContent-Length: 2\r\n\r\nhi`));
  await report("routing_header", () =>
    tunnel(A, A, get("/v1/messages", A, "GET", "X-Original-URL: /v1/files\r\n")));
  await report("underscore_key", () =>
    tunnel(A, A, get("/v1/messages", A, "POST", "x_api_key: sk-attacker\r\n")));
  await report("bare_cr", () =>
    tunnel(A, A, get("/v1/messages", A, "POST", "X-A: b\rx-api-key: sk-attacker\r\n")));
  await report("large_denied_body", () =>
    tunnel(A, A, `POST /v1/files HTTP/1.1\r\nHost: ${A}\r\nContent-Length: ${64 * 1024 * 1024}\r\n\r\n`));
  await report("deny_variant_slash", () =>
    tunnel("denied-rule.invalid", "denied-rule.invalid", get("/private%2fa", "denied-rule.invalid")));
  await report("deny_variant_case", () =>
    tunnel("denied-rule.invalid", "denied-rule.invalid", get("/PRIVATE/a", "denied-rule.invalid")));
  await report("private_literal", () => tunnel("169.254.169.254", undefined, get("/", "169.254.169.254")));
  await report("private_name", () => tunnel("localhost", "localhost", get("/", "localhost")));
  await report("user_deny", () => tunnel("denied-rule.invalid", "denied-rule.invalid", get("/private/a", "denied-rule.invalid")));
} else if (mode === "rotation") {
  const go = process.argv[3];
  const bearer = "Authorization: Bearer rotated-token\r\n";
  await report("before", () => tunnel(A, A, get("/v1/messages", A, "POST", bearer)));
  while (!fs.existsSync(go)) await new Promise((r) => setTimeout(r, 200));
  await report("after", () => tunnel(A, A, get("/v1/messages", A, "POST", bearer)));
} else if (mode === "wait") {
  const stop = process.argv[3];
  console.log("waiting");
  while (!fs.existsSync(stop)) await new Promise((r) => setTimeout(r, 200));
  await report("after_stop", async () => {
    const c = await connect(A);
    c.socket?.destroy();
    return c.code ?? "none";
  });
}
process.exit(0);
