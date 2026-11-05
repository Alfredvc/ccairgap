import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashToken } from "./network.js";

// Runs docker/network/policy.py under python3 with a stub of the one mitmproxy
// module that it imports. E2e tests cover the addon in the real image, but e2e
// does not run in CI, and the addon holds every security decision of the feature.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const STUB = `
class Response:
    @staticmethod
    def make(status, body):
        return {"status": status}
class HTTPFlow:
    pass
`;

const DRIVER = `
import asyncio, contextlib, io, json, sys, types
sys.path.insert(0, sys.argv[1])
import policy

class Headers:
    def __init__(self, pairs):
        self.fields = [(k.encode("latin-1"), v.encode("latin-1")) for k, v in pairs]
    def __contains__(self, name):
        return any(k.decode("latin-1").lower() == name for k, _ in self.fields)
    def get(self, name, default=None):
        for k, v in self.fields:
            if k.decode("latin-1").lower() == name:
                return v.decode("latin-1")
        return default
    def pop(self, name, default=None):
        self.fields = [f for f in self.fields if f[0].decode("latin-1").lower() != name]

def make_flow(case):
    host = case.get("host", "allowed.test")
    req = types.SimpleNamespace(
        host=case.get("reqHost", host),
        port=case.get("port", 443),
        # mitmproxy uppercases this property, and sends data.method upstream.
        method=case.get("method", "GET").upper(),
        data=types.SimpleNamespace(method=case.get("method", "GET").encode("latin-1")),
        path=case.get("path", "/public/a"),
        http_version=case.get("version", "HTTP/1.1"),
        authority=case.get("authority", ""),
        pretty_host=case.get("prettyHost", host),
        headers=Headers(case.get("headers", [])),
        stream=False,
    )
    flow = types.SimpleNamespace(
        request=req,
        response=None,
        killed=False,
        client_conn=types.SimpleNamespace(id=case.get("client", "c"), sni=case.get("sni", host)),
    )
    def kill():
        flow.killed = True
    flow.kill = kill
    return flow

class FakeLoop:
    def __init__(self, result):
        self.result = result
    async def getaddrinfo(self, host, port, **kwargs):
        if self.result is None:
            raise OSError("no such host")
        return [(10 if ":" in a else 2, 1, 6, "", (a, port)) for a in self.result]

def run(case):
    op = case["op"]
    if op == "decide":
        return policy.decide(make_flow(case), case.get("host", "allowed.test"), case.get("port", 443))
    if op == "connect":
        return policy.connect_allowed(case["host"], case["port"])
    if op == "path":
        return list(policy.canonical_path(case["path"]))
    if op == "public":
        return policy.is_public(case["address"])
    if op == "connect-hook":
        flow = make_flow(case)
        if case.get("raise"):
            policy.connect_allowed = None
        policy.http_connect(flow)
        return {"response": flow.response, "target": policy.TUNNEL_TARGETS.get(flow.client_conn.id)}
    if op == "request-hook":
        flow = make_flow(case)
        if case.get("raise"):
            policy.decide = None
        policy.requestheaders(flow)
        return {
            "response": flow.response,
            "killed": flow.killed,
            "stream": flow.request.stream,
            "cookie": "cookie" in flow.request.headers,
        }
    if op == "resolve":
        loop = FakeLoop(case["result"])
        policy.guard_resolver(loop)
        async def go():
            try:
                infos = await loop.getaddrinfo(case["name"], 443)
                return [i[4][0] for i in infos]
            except OSError as e:
                return "error"
        return asyncio.run(go())
    if op == "server-hook":
        data = types.SimpleNamespace(server=types.SimpleNamespace(address=(case["name"], 443), error=None))
        if case.get("guardFails"):
            def broken(_loop):
                raise RuntimeError("guard failed")
            policy.guard_resolver = broken
        guarded = {}
        async def go():
            await policy.server_connect(data)
            guarded["value"] = getattr(asyncio.get_running_loop(), "ccairgap_guarded", False)
        asyncio.run(go())
        return {"error": data.server.error is not None, "address": data.server.address[0], "guarded": guarded["value"]}
    if op == "hook-log":
        lines = io.StringIO()
        with contextlib.redirect_stdout(lines):
            policy.requestheaders(make_flow(case))
        return [json.loads(line) for line in lines.getvalue().splitlines()]
    if op == "disconnect":
        policy.client_disconnected(types.SimpleNamespace(id=case["client"]))
        return policy.TUNNEL_TARGETS.get(case["client"])
    if op == "tcp":
        flow = make_flow(case)
        policy.tcp_start(flow)
        return flow.killed
    if op == "websocket":
        flow = types.SimpleNamespace(websocket=types.SimpleNamespace(messages=[1, 2, 3]))
        policy.websocket_message(flow)
        return len(flow.websocket.messages)
    raise AssertionError(op)

real_stdout = sys.stdout
sys.stdout = sys.stderr
results = [run(c) for c in json.load(open(sys.argv[2]))]
json.dump(results, real_stdout)
`;

const GOOD_TOKEN = "good-token";

const RULES = [
  { action: "allow", host: "allowed.test", ports: [443], methods: ["GET", "POST"], paths: ["/public/*"] },
  { action: "deny", host: "mixed.test", paths: ["/admin", "/private/*", "/deep/path"] },
  { action: "allow", host: "mixed.test", ports: [443] },
  { action: "deny", host: "blocked.example.com" },
  { action: "allow", host: "*.example.com", ports: [80, 443] },
  { action: "allow", host: "api.anthropic.com", ports: [443] },
  { action: "allow", host: "no-hashes.test", ports: [443] },
  { action: "allow", host: "exact.test", ports: [443], paths: ["/only"] },
];

let dir: string;

function run(cases: object[]): unknown[] {
  const file = join(dir, `cases-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(cases));
  const r = spawnSync("python3", ["-I", join(dir, "driver.py"), dir, file], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`driver failed: ${r.stderr}`);
  return JSON.parse(r.stdout) as unknown[];
}

function decide(cases: object[]): unknown[] {
  return run(cases.map((c) => ({ op: "decide", ...c })));
}

beforeAll(() => {
  // A missing interpreter must fail this suite. A skip would hide the whole addon.
  expect(spawnSync("python3", ["--version"]).status).toBe(0);
  dir = mkdtempSync(join(tmpdir(), "ccairgap-policy-"));
  mkdirSync(join(dir, "mitmproxy"));
  writeFileSync(join(dir, "mitmproxy", "__init__.py"), "");
  writeFileSync(join(dir, "mitmproxy", "http.py"), STUB);
  writeFileSync(join(dir, "driver.py"), DRIVER);
  copyFileSync(join(ROOT, "docker", "network", "policy.py"), join(dir, "policy.py"));
  writeFileSync(
    join(dir, "policy.json"),
    JSON.stringify({ rules: RULES, credentialHosts: ["api.anthropic.com", "no-hashes.test"] }),
  );
  mkdirSync(join(dir, "credentials"));
  writeFileSync(
    join(dir, "credentials", "api.anthropic.com"),
    `${hashToken(GOOD_TOKEN)}\n`,
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("request names", () => {
  it("allows a normal tunnel request and a matching absolute form", () => {
    expect(decide([{}, { authority: "allowed.test:443" }, { authority: "ALLOWED.test" }])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("denies an HTTP/2.0 label, which makes mitmproxy ignore the Host header", () => {
    expect(
      decide([{ version: "HTTP/2.0", authority: "allowed.test", headers: [["Host", "secret.test"]] }]),
    ).toEqual(["http-version"]);
  });

  it("denies an absolute form that names another host", () => {
    expect(decide([{ authority: "secret.test" }, { authority: "secret.test:443" }, { authority: "allowed.test@secret.test" }])).toEqual([
      "authority-mismatch",
      "authority-mismatch",
      "authority-mismatch",
    ]);
  });

  it("denies a Host header or SNI that names another host", () => {
    expect(decide([{ prettyHost: "secret.test" }, { sni: "secret.test" }])).toEqual([
      "host-header-mismatch",
      "sni-mismatch",
    ]);
  });
});

describe("headers", () => {
  it.each([
    "x-http-method-override",
    "X-HTTP-Method",
    "X_HTTP_Method_Override",
    "x-method-override",
    "X-Original-URL",
    "x-rewrite-url",
    "X-Forwarded-Host",
    "Forwarded",
  ])("denies routing header %s", (name) => {
    expect(decide([{ headers: [[name, "x"]] }])).toEqual(["routing-header"]);
  });

  it("denies bytes that a server could read as another header", () => {
    expect(
      decide([
        { headers: [["X-A", "b\rx-api-key: attacker"]] },
        { headers: [["X-A", "b\r\n c"]] },
        { headers: [["X-A", "b\u0000"]] },
        { headers: [["X A", "b"]] },
      ]),
    ).toEqual(["header-bytes", "header-bytes", "header-bytes", "header-bytes"]);
  });

  it("allows ordinary headers", () => {
    expect(decide([{ headers: [["Accept", "*/*"], ["User-Agent", "a b"]] }])).toEqual([null]);
  });
});

describe("methods and bodies", () => {
  it("applies the method list, and denies a method that is not uppercase", () => {
    expect(decide([{ method: "DELETE" }, { method: "get" }])).toEqual(["no-matching-rule", "method-form"]);
  });

  it("denies a body on GET and HEAD", () => {
    expect(
      decide([
        { headers: [["Content-Length", "5"]] },
        { headers: [["Transfer-Encoding", "chunked"]] },
        { headers: [["Content-Length", "0"]] },
        { method: "POST", headers: [["Content-Length", "5"]] },
      ]),
    ).toEqual(["body-on-get", "body-on-get", null, null]);
  });
});

describe("path checks", () => {
  it.each([
    ["/public/../secret", "path-dot-segment"],
    ["/public/%2e%2e/secret", "path-dot-segment"],
    ["/public/%252e%252e/secret", "path-dot-segment"],
    ["/public/..%2fsecret", "path-dot-segment"],
    ["/public/..;x/secret", "path-dot-segment"],
    ["/public/..%20/secret", "path-dot-segment"],
    ["/public/.../secret", "path-dot-segment"],
    ["/public/%ef%bc%8e%ef%bc%8e/secret", "path-dot-segment"],
    ["/public/%c0%ae%c0%ae/secret", "path-encoding"],
    ["/public/..%c0%af/secret", "path-encoding"],
    ["/public/%u002e%u002e/secret", "path-encoding"],
    ["/public/a\\b", "path-character"],
    ["/public/a%5cb", "path-character"],
    ["/public/%ef%bc%bcb", "path-character"],
    ["/public/a%00b", "path-character"],
    ["/public/a%0ab", "path-character"],
    ["/public/a#b", "path-character"],
    ["//public/a", "path-empty-segment"],
    ["/public//a", "path-empty-segment"],
    ["public/a", "path-form"],
    ["*", "path-form"],
    [`/public/${"%25".repeat(1)}${"25".repeat(9)}`, "path-encoding"],
    [`/public/${"a".repeat(9000)}`, "path-length"],
  ])("refuses %s", (path, reason) => {
    expect(run([{ op: "path", path }])).toEqual([[null, reason]]);
  });

  it("decodes a normal path, keeps an encoded slash encoded, and keeps UTF-8", () => {
    expect(run([{ op: "path", path: "/public/a%20b" }])).toEqual([["/public/a b", null]]);
    expect(run([{ op: "path", path: "/public/a%2Fb" }])).toEqual([["/public/a%2Fb", null]]);
    expect(run([{ op: "path", path: "/public/a%2fb/" }])).toEqual([["/public/a%2Fb/", null]]);
    expect(decide([{ path: "/public/caf%C3%A9" }, { path: "/public/a?x=../../y" }])).toEqual([null, null]);
  });

  it("does not let an encoded slash or case change match an allow rule", () => {
    expect(
      decide([{ path: "/public%2Fa" }, { path: "/PUBLIC/a" }, { path: "/other" }]),
    ).toEqual(["no-matching-rule", "no-matching-rule", "no-matching-rule"]);
  });
});

describe("deny rules", () => {
  const host = "mixed.test";

  it.each([
    "/admin",
    "/admin/",
    "/ADMIN",
    "/admin;x",
    "/private/x",
    "/private%2fx",
    "/private%2Fx",
    "/PRIVATE/x",
    "/private;a/x",
    "/deep%2F%2Fpath",
  ])("denies the variant %s", (path) => {
    expect(decide([{ host, path }])).toEqual(["rule-deny"]);
  });

  it("denies the fragment form through the path check", () => {
    expect(decide([{ host, path: "/admin#x" }])).toEqual(["path-character"]);
  });

  it("lets the tunnel open when a deny rule names only paths", () => {
    expect(run([{ op: "connect", host, port: 443 }])).toEqual([true]);
  });

  it("does not spread to other paths", () => {
    expect(decide([{ host, path: "/administrator" }, { host, path: "/public" }, { host, path: "/" }])).toEqual([
      null,
      null,
      null,
    ]);
  });

  it("covers every port when the rule names none", () => {
    expect(
      run([
        { op: "connect", host: "blocked.example.com", port: 443 },
        { op: "connect", host: "blocked.example.com", port: 80 },
        { op: "connect", host: "other.example.com", port: 80 },
      ]),
    ).toEqual([false, false, true]);
  });
});

describe("host matching in CONNECT", () => {
  it("applies the port list, the wildcard depth, and the no-match default", () => {
    expect(
      run([
        { op: "connect", host: "allowed.test", port: 443 },
        { op: "connect", host: "allowed.test", port: 80 },
        { op: "connect", host: "a.b.example.com", port: 443 },
        { op: "connect", host: "example.com", port: 443 },
        { op: "connect", host: "notexample.com", port: 443 },
        { op: "connect", host: "other.test", port: 443 },
        { op: "connect", host: ".example.com", port: 443 },
      ]),
    ).toEqual([true, false, true, false, false, false, false]);
  });

  it("compares the CONNECT host in lowercase", () => {
    expect(run([{ op: "connect-hook", reqHost: "ALLOWED.TEST", host: "allowed.test", client: "u" }])).toEqual([
      { response: null, target: ["allowed.test", 443] },
    ]);
  });
});

describe("credential check", () => {
  const host = "api.anthropic.com";

  it("allows the stored token and a request with no token", () => {
    expect(
      decide([
        { host, path: "/v1/messages" },
        { host, headers: [["Authorization", `Bearer ${GOOD_TOKEN}`]] },
        { host, headers: [["authorization", `bearer ${GOOD_TOKEN}`]] },
        { host, headers: [["x-api-key", GOOD_TOKEN]] },
      ]),
    ).toEqual([null, null, null, null]);
  });

  it.each([
    [[["Authorization", "Bearer attacker"]]],
    [[["x-api-key", "attacker"]]],
    [[["x_api_key", "attacker"]]],
    [[["Authorization", `attacker ${GOOD_TOKEN}`]]],
    [[["Authorization", `Basic ${GOOD_TOKEN}`]]],
    [[["Authorization", `Bearer ${GOOD_TOKEN}`], ["x-api-key", "attacker"]]],
    [[["x-api-key", `${GOOD_TOKEN}, attacker`]]],
  ])("denies %j", (headers) => {
    expect(decide([{ host, headers }])).toEqual(["credential"]);
  });

  it("denies each token when the host has no hash file, and allows no token", () => {
    const host = "no-hashes.test";
    expect(decide([{ host, headers: [["x-api-key", GOOD_TOKEN]] }, { host }])).toEqual(["credential", null]);
  });

  it("does not check tokens on other hosts", () => {
    expect(decide([{ headers: [["x-api-key", "attacker"]] }])).toEqual([null]);
  });

  it("removes cookies on a credential host only", () => {
    expect(
      run([
        { op: "request-hook", host, path: "/v1/messages", headers: [["Cookie", "a=b"]] },
        { op: "request-hook", headers: [["Cookie", "a=b"]] },
      ]),
    ).toMatchObject([{ cookie: false, stream: true }, { cookie: true, stream: true }]);
  });
});

describe("address checks", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "172.17.0.1",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "100.100.100.200",
    "168.63.129.16",
    "192.88.99.1",
    "224.0.0.1",
    "0.0.0.0",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "fec0::1",
    "5f00::1",
    "2001::1",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    "::169.254.169.254",
    "::ffff:0:a9fe:a9fe",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b:1::1",
    "2002:7f00:1::",
    "2002:a9fe:a9fe::",
    "::ffff:168.63.129.16",
  ])("refuses %s", (address) => {
    expect(run([{ op: "public", address }])).toEqual([false]);
  });

  it.each(["1.1.1.1", "93.184.216.34", "2606:4700:4700::1111", "::ffff:1.1.1.1", "64:ff9b::101:101", "2002:101:101::"])(
    "accepts %s",
    (address) => {
      expect(run([{ op: "public", address }])).toEqual([true]);
    },
  );

  it("refuses a lookup if any result is not public, and fails when nothing resolves", () => {
    expect(
      run([
        { op: "resolve", name: "a.test", result: ["1.1.1.1"] },
        { op: "resolve", name: "b.test", result: ["1.1.1.1", "10.0.0.1"] },
        { op: "resolve", name: "c.test", result: [] },
        { op: "resolve", name: "d.test", result: null },
        { op: "resolve", name: "e.test", result: ["not-an-address"] },
      ]),
    ).toEqual([["1.1.1.1"], "error", "error", "error", "error"]);
  });

  it("orders IPv4 results first", () => {
    expect(run([{ op: "resolve", name: "a.test", result: ["2606:4700:4700::1111", "1.1.1.1"] }])).toEqual([
      ["1.1.1.1", "2606:4700:4700::1111"],
    ]);
  });

  it("refuses a private IP literal, keeps a name in place, and installs the guard", () => {
    expect(
      run([
        { op: "server-hook", name: "127.0.0.1" },
        { op: "server-hook", name: "1.1.1.1" },
        { op: "server-hook", name: "allowed.test" },
      ]),
    ).toEqual([
      { error: true, address: "127.0.0.1", guarded: true },
      { error: false, address: "1.1.1.1", guarded: true },
      { error: false, address: "allowed.test", guarded: true },
    ]);
  });

  it("refuses the connection when installing the guard fails", () => {
    // A hook that raises lets the flow continue in mitmproxy, so the name would
    // reach the resolver with no address check.
    expect(run([{ op: "server-hook", name: "allowed.test", guardFails: true }])).toEqual([
      { error: true, address: "allowed.test", guarded: false },
    ]);
  });
});

describe("hooks", () => {
  it("denies with 403 and records the tunnel target only for an allowed CONNECT", () => {
    expect(
      run([
        { op: "connect-hook", host: "allowed.test", client: "ok" },
        { op: "connect-hook", host: "other.test", client: "no" },
      ]),
    ).toEqual([
      { response: null, target: ["allowed.test", 443] },
      { response: { status: 403 }, target: null },
    ]);
  });

  it("fails closed when a decision raises an exception", () => {
    expect(run([{ op: "connect-hook", host: "allowed.test", client: "x", raise: true }])).toEqual([
      { response: { status: 403 }, target: null },
    ]);
    expect(run([{ op: "request-hook", raise: true }])).toMatchObject([
      { response: { status: 403 }, stream: false },
    ]);
  });

  it("kills a denied request with a large or unknown body, and answers a small one", () => {
    const big = String(2 * 1024 * 1024);
    expect(
      run([
        { op: "request-hook", method: "DELETE", headers: [["Content-Length", "10"]] },
        { op: "request-hook", method: "DELETE", headers: [["Content-Length", big]] },
        { op: "request-hook", method: "DELETE", headers: [["Transfer-Encoding", "chunked"]] },
      ]),
    ).toMatchObject([
      { response: { status: 403 }, killed: false, stream: false },
      { response: null, killed: true, stream: false },
      { response: null, killed: true, stream: false },
    ]);
  });

  it("kills a denied request with an unreadable Content-Length", () => {
    expect(
      run([{ op: "request-hook", method: "DELETE", headers: [["Content-Length", "abc"]] }]),
    ).toMatchObject([{ response: null, killed: true }]);
  });

  it("matches an exact allow path as a whole", () => {
    const host = "exact.test";
    expect(decide([{ host, path: "/only" }, { host, path: "/onlyx" }, { host, path: "/only/x" }])).toEqual([
      null,
      "no-matching-rule",
      "no-matching-rule",
    ]);
  });

  it("matches rules against the CONNECT target of the tunnel", () => {
    expect(
      run([
        { op: "connect-hook", host: "allowed.test", client: "tunnel" },
        { op: "request-hook", host: "allowed.test", reqHost: "203.0.113.9", client: "tunnel" },
      ])[1],
    ).toMatchObject({ response: null, stream: true });
  });

  it("forgets the tunnel target when the client disconnects", () => {
    expect(
      run([
        { op: "connect-hook", host: "allowed.test", client: "gone" },
        { op: "disconnect", client: "gone" },
      ])[1],
    ).toBeNull();
  });

  it("kills a raw TCP stream", () => {
    expect(run([{ op: "tcp" }])).toEqual([true]);
  });

  it("numbers denials and logs no query string", () => {
    const path = "/public/a?secret=value";
    expect(
      run([
        { op: "hook-log", path },
        { op: "hook-log", method: "DELETE", path },
        { op: "hook-log", method: "PUT", path },
      ]),
    ).toEqual([
      [{ stage: "request", verdict: "allow", method: "GET", host: "allowed.test", port: 443, path: "/public/a" }],
      [
        {
          stage: "request",
          verdict: "deny",
          why: "no-matching-rule",
          seq: 1,
          method: "DELETE",
          host: "allowed.test",
          port: 443,
          path: "/public/a",
        },
      ],
      [
        {
          stage: "request",
          verdict: "deny",
          why: "no-matching-rule",
          seq: 2,
          method: "PUT",
          host: "allowed.test",
          port: 443,
          path: "/public/a",
        },
      ],
    ]);
  });

  it("logs at most 512 characters of a path", () => {
    const [entries] = run([{ op: "hook-log", path: `/public/${"a".repeat(600)}` }]) as Array<Array<{ path: string }>>;
    expect(entries![0]!.path).toHaveLength(512);
  });

  it("does not keep WebSocket messages in the flow", () => {
    expect(run([{ op: "websocket" }])).toEqual([0]);
  });
});

describe("policy.py file", () => {
  it("reads its config beside itself, so the sidecar mount path stays the only input", () => {
    const source = readFileSync(join(ROOT, "docker", "network", "policy.py"), "utf8");
    expect(source).not.toContain('"/ccairgap');
    expect(source).not.toContain("os.environ");
  });
});
