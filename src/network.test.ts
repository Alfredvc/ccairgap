import { linkSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "./config.js";
import {
  addCredentialHash,
  agentPresetRules,
  claudeAccessToken,
  codexToken,
  findNetworkConflicts,
  findNetworkPathConflicts,
  formatNetworkPlan,
  hashToken,
  NETWORK_SIDECAR_IMAGE,
  networkAgentDockerArgs,
  networkAgentEnv,
  networkProtectedPaths,
  parseNetworkConfig,
  planNetworkPolicy,
  sidecarDockerArgs,
  summarizeDenials,
} from "./network.js";

describe("parseNetworkConfig", () => {
  it("treats an empty key as an active preset-only policy", () => {
    const empty = { agentPreset: true, checkCredentials: true, rules: [] };
    expect(parseNetworkConfig(null)).toEqual(empty);
    expect(parseNetworkConfig({})).toEqual(empty);
    expect(parseNetworkConfig({ rules: null })).toEqual(empty);
  });

  it("applies rule defaults and normalizes host and methods", () => {
    const cfg = parseNetworkConfig({
      rules: [{ host: "GitHub.com", methods: ["get", "POST"], paths: ["/acme/*"] }],
    });
    expect(cfg.rules).toEqual([
      {
        action: "allow",
        host: "github.com",
        ports: [443],
        methods: ["GET", "POST"],
        paths: ["/acme/*"],
      },
    ]);
  });

  it("accepts kebab-case and camelCase option keys", () => {
    expect(parseNetworkConfig({ "agent-preset": false }).agentPreset).toBe(false);
    expect(parseNetworkConfig({ agentPreset: false }).agentPreset).toBe(false);
    expect(parseNetworkConfig({ "check-credentials": false }).checkCredentials).toBe(false);
    expect(parseNetworkConfig({ checkCredentials: false }).checkCredentials).toBe(false);
  });

  it.each([
    [{ rules: [{}] }, /host is required/],
    [{ rules: [{ host: "*" }] }, /invalid host/],
    [{ rules: [{ host: "*.com" }] }, /top-level domain/],
    [{ rules: [{ host: "a.com/x" }] }, /invalid host/],
    [{ rules: [{ host: "::1" }] }, /invalid host/],
    [{ rules: [{ host: "a.com", action: "block" }] }, /allow or deny/],
    [{ rules: [{ host: "a.com", ports: [0] }] }, /port number/],
    [{ rules: [{ host: "a.com", ports: [] }] }, /at least one/],
    [{ rules: [{ host: "a.com", methods: ["G T"] }] }, /HTTP method/],
    [{ rules: [{ host: "a.com", paths: ["x"] }] }, /start with/],
    [{ rules: [{ host: "a.com", paths: ["/x?y=1"] }] }, /cannot match/],
    [{ rules: [{ host: "a.com", paths: ["/%2e%2e"] }] }, /percent-encoding/],
    [{ rules: [{ host: "a.com", ports: [65536] }] }, /port number/],
    [{ rules: [{ host: "a.com", ports: [1.5] }] }, /port number/],
    [{ rules: [{ host: "a.com", paths: ["/a\\b"] }] }, /cannot match/],
    [{ rules: [{ host: "a.com", paths: ["/a#b"] }] }, /cannot match/],
    [{ rules: [{ host: "a.com", paths: ["/a b"] }] }, /cannot match/],
    [{ rules: "all" }, /expected list/],
    [{ "agent-preset": "yes" }, /expected boolean/],
    [{ "check-credentials": "no" }, /expected boolean/],
    [{ rules: [{ host: "a.com", url: "x" }] }, /unknown key/],
    [{ bogus: 1 }, /unknown key/],
    ["all", /expected map/],
  ])("rejects %j", (input, message) => {
    expect(() => parseNetworkConfig(input)).toThrow(message);
  });

  it("is reachable through parseConfig, and an empty block activates it", () => {
    expect(parseConfig("network:\n", "t").network).toEqual({
      agentPreset: true,
      checkCredentials: true,
      rules: [],
    });
    expect(parseConfig("repo: /x\n", "t").network).toBeUndefined();
  });
});

describe("planNetworkPolicy", () => {
  const base = { agentPreset: true, checkCredentials: true, rules: [] };

  it("selects the preset by agent and auth kind", () => {
    expect(agentPresetRules("claude")[0]!.host).toBe("api.anthropic.com");
    expect(agentPresetRules("codex", "chatgpt-token")[0]!.host).toBe("chatgpt.com");
    expect(agentPresetRules("codex", "api-key")[0]!.host).toBe("api.openai.com");
  });

  it("allows exactly the measured requests of each agent", () => {
    expect(agentPresetRules("claude")).toEqual([
      {
        action: "allow",
        host: "api.anthropic.com",
        ports: [443],
        methods: ["GET", "POST"],
        paths: ["/v1/messages", "/v1/messages/count_tokens", "/v1/mcp_servers", "/api/web/domain_info"],
      },
    ]);
    expect(agentPresetRules("codex", "api-key")).toEqual([
      { action: "allow", host: "api.openai.com", ports: [443], methods: ["GET", "POST"], paths: ["/v1/responses"] },
    ]);
    expect(agentPresetRules("codex", "chatgpt-token")).toEqual([
      {
        action: "allow",
        host: "chatgpt.com",
        ports: [443],
        methods: ["GET"],
        paths: ["/backend-api/codex/responses", "/backend-api/codex/models", "/backend-api/wham/accounts/check"],
      },
    ]);
  });

  it("checks credentials on each host where a token selects the account", () => {
    expect(planNetworkPolicy(base, "claude").credentialHosts).toEqual([
      "api.anthropic.com",
      "chatgpt.com",
      "api.openai.com",
    ]);
  });

  it("prints each active rule and the credential check", () => {
    const plan = planNetworkPolicy(
      { ...base, rules: [{ action: "deny", host: "a.test" }, { action: "allow", host: "b.test", ports: [80] }] },
      "claude",
    );
    expect(formatNetworkPlan(plan)).toEqual([
      "ccairgap: network policy active. First match wins, and no match denies.",
      "  rule: deny a.test:any port any method any path",
      "  rule: allow b.test:80 any method any path",
      "  preset: allow api.anthropic.com:443 GET,POST /v1/messages /v1/messages/count_tokens /v1/mcp_servers /api/web/domain_info",
      "  credential check: on",
    ]);
    expect(formatNetworkPlan({ rules: [], userRuleCount: 0, credentialHosts: [] })).toEqual([
      "ccairgap: network policy active. First match wins, and no match denies.",
      "  no rules: every request is denied",
      "  credential check: off",
    ]);
  });

  it("keeps a path allowlist on every preset", () => {
    for (const rule of [
      ...agentPresetRules("claude"),
      ...agentPresetRules("codex", "chatgpt-token"),
      ...agentPresetRules("codex", "api-key"),
    ]) {
      expect(rule.paths?.length).toBeGreaterThan(0);
      expect(rule.paths!.some((p) => p.includes("*"))).toBe(false);
    }
  });

  it("puts user rules before the preset so a deny can narrow it", () => {
    const deny = { action: "deny" as const, host: "api.anthropic.com", ports: [443] };
    const plan = planNetworkPolicy({ ...base, rules: [deny] }, "claude");
    expect(plan.rules[0]).toEqual(deny);
    expect(plan.rules[1]!.action).toBe("allow");
    expect(plan.userRuleCount).toBe(1);
  });

  it("omits the preset and the credential hosts on request", () => {
    const plan = planNetworkPolicy(
      { agentPreset: false, checkCredentials: false, rules: [] },
      "claude",
    );
    expect(plan.rules).toEqual([]);
    expect(plan.credentialHosts).toEqual([]);
  });
});

describe("findNetworkConflicts", () => {
  it.each([
    "--network",
    "--network=host",
    "--net=foo",
    "--link",
    "--privileged",
    "--cap-add=NET_ADMIN",
    "-p",
    "-P",
    "-p8080:80",
    "-dp",
    "-itP",
    "--publish=1:1",
    "/var/run/docker.sock:/s",
    "ccairgap-x-network:/y",
  ])("rejects %s", (token) => {
    expect(findNetworkConflicts([token])).toEqual([token]);
  });

  it.each(["-e", "FOO=bar", "--label", "-v", "/a:/b", "-ePATH=1", "--memory=1g", "--env=P=1", "--add-host=h:host-gateway", "--dns=1.1.1.1"])(
    "accepts %s",
    (token) => {
      expect(findNetworkConflicts([token])).toEqual([]);
    },
  );
});

describe("findNetworkConflicts flag list", () => {
  it.each([
    "--network",
    "--net",
    "--link",
    "--network-alias",
    "--net-alias",
    "--ip",
    "--ip6",
    "--publish",
    "--publish-all",
    "--privileged",
    "--cap-add",
    "--pid",
    "--ipc",
    "--uts",
    "--userns",
    "--cgroupns",
    "--runtime",
    "--device",
    "--security-opt",
    "--volumes-from",
  ])("rejects %s in both forms", (flag) => {
    expect(findNetworkConflicts([flag])).toEqual([flag]);
    expect(findNetworkConflicts([`${flag}=x`])).toEqual([`${flag}=x`]);
  });
});

describe("findNetworkConflicts values", () => {
  it("ignores env and label values, and still finds a flag after them", () => {
    expect(findNetworkConflicts(["-e", "DOCKER_HOST=unix:///var/run/docker.sock"])).toEqual([]);
    expect(findNetworkConflicts(["--env=X=ccairgap-a-network"])).toEqual([]);
    expect(findNetworkConflicts(["--label", "x", "--privileged"])).toEqual(["--privileged"]);
  });

  it("still finds a socket in a mount", () => {
    const mount = "/var/run/docker.sock:/s";
    expect(findNetworkConflicts(["-v", mount])).toEqual([mount]);
  });

  it("does not let a value-taking flag hide a flag behind -e", () => {
    // docker reads this "-e" as the value of --dns-option, then acts on --privileged.
    expect(findNetworkConflicts(["--dns-option", "-e", "--privileged"])).toEqual(["--privileged"]);
    expect(findNetworkConflicts(["--dns-option", "-l", "--cap-add=SYS_ADMIN"])).toEqual([
      "--cap-add=SYS_ADMIN",
    ]);
    expect(findNetworkConflicts(["--dns-option", "-e", "--pid=host"])).toEqual(["--pid=host"]);
  });

  it("finds clusters and flags that attach another container's mounts", () => {
    expect(findNetworkConflicts(["-qP"])).toEqual(["-qP"]);
    expect(findNetworkConflicts(["--volumes-from", "x"])).toEqual(["--volumes-from"]);
  });
});

describe("mount conflicts", () => {
  const paths = { sockets: ["/var/run/docker.sock", "/run/docker.sock"], stateRoot: "/home/u/.local/state/ccairgap" };

  it.each([
    [["-v", "/var/run:/x"], ["/var/run:/x"]],
    [["--volume", "/run:/x"], ["/run:/x"]],
    [["--volume=/var/run:/x"], ["--volume=/var/run:/x"]],
    [["-v=/var/run:/x"], ["-v=/var/run:/x"]],
    [["-v/var/run:/x"], ["-v/var/run:/x"]],
    [["-dv/var/run:/x"], ["-dv/var/run:/x"]],
    [["--mount", "type=bind,src=/var/run,dst=/x"], ["type=bind,src=/var/run,dst=/x"]],
    [["--mount=type=bind,source=/,target=/x"], ["--mount=type=bind,source=/,target=/x"]],
    [["-v", "/home/u:/x"], ["/home/u:/x"]],
    [["-v", "/home/u/.local/state/ccairgap/sessions/a:/x"], ["/home/u/.local/state/ccairgap/sessions/a:/x"]],
  ])("rejects a source that exposes a socket or session state: %j", (tokens, expected) => {
    expect(findNetworkConflicts(tokens, paths)).toEqual(expected);
  });

  it.each([
    [["-v", "/data:/x"]],
    [["--mount", "type=bind,src=/data,dst=/x"]],
    [["-v", "named-volume:/x"]],
    [["--mount", "type=tmpfs,dst=/x"]],
    [["-v", "/home/ux:/x"]],
  ])("allows an unrelated source: %j", (tokens) => {
    expect(findNetworkConflicts(tokens, paths)).toEqual([]);
  });

  it("rejects --ro over a socket and --mount over a socket or session state", () => {
    expect(findNetworkPathConflicts({ ro: ["/var/run", "/data"], mount: [] }, paths)).toEqual(["/var/run"]);
    // A read-only view of session state cannot change the policy.
    expect(findNetworkPathConflicts({ ro: ["/home/u"], mount: [] }, paths)).toEqual([]);
    expect(findNetworkPathConflicts({ ro: [], mount: ["/home/u", "/data"] }, paths)).toEqual(["/home/u"]);
  });

  it("lists a home socket only when it exists", () => {
    const found = networkProtectedPaths("/s", { HOME: "/nonexistent-home" });
    expect(found.sockets).toEqual(["/var/run/docker.sock", "/run/docker.sock"]);
    expect(found.stateRoot).toBe("/s");
  });
});

describe("summarizeDenials rotation", () => {
  it("counts denials that log rotation removed", () => {
    const log = [
      JSON.stringify({ verdict: "deny", why: "x", seq: 41, host: "a.test", port: 443 }),
      JSON.stringify({ verdict: "deny", why: "x", seq: 42, host: "a.test", port: 443 }),
    ].join("\n");
    const summary = summarizeDenials(log);
    expect(summary.total).toBe(42);
    expect(summary.lines.at(-1)).toContain("40 earlier denials");
  });
});

describe("deny rule ports", () => {
  it("leaves ports unset on a deny rule, so the rule covers every port", () => {
    const cfg = parseNetworkConfig({ rules: [{ action: "deny", host: "a.test" }, { host: "b.test" }] });
    expect(cfg.rules[0]!.ports).toBeUndefined();
    expect(cfg.rules[1]!.ports).toEqual([443]);
  });
});

describe("docker argv", () => {
  it("runs the agent with no network and read-only network mounts", () => {
    const args = networkAgentDockerArgs("abc", "/s");
    expect(args).toEqual([
      "--network",
      "none",
      "-v",
      "/s/network/agent:/run/ccairgap-network/agent:ro",
      "-v",
      "ccairgap-abc-network:/run/ccairgap-network/sock:ro",
    ]);
  });

  it("hardens the sidecar and publishes nothing", () => {
    const args = sidecarDockerArgs({ id: "abc", sessionDir: "/s", uid: 501, gid: 20 });
    for (const flag of ["--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--memory=1g"]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain("/ca:uid=501,gid=20,mode=700");
    expect(args).toContain("501:20");
    expect(args).toContain("/s/network/sidecar:/ccairgap:ro");
    expect(args).toContain(NETWORK_SIDECAR_IMAGE);
    expect(args.some((a) => a === "-p" || a === "--publish")).toBe(false);
    expect(args.join(" ")).not.toContain("docker.sock");
    const command = args.slice(args.indexOf(NETWORK_SIDECAR_IMAGE) + 1).join(" ");
    expect(args[args.indexOf(NETWORK_SIDECAR_IMAGE) - 1]).toBe("python3");
    expect(command.startsWith("/ccairgap/relay.py mitmdump ")).toBe(true);
    for (const option of ["connection_strategy=lazy", "rawtcp=false", "http2=false", "http3=false"]) {
      expect(command).toContain(option);
    }
    expect(command).toContain("--listen-host 127.0.0.1");
  });

  it("passes exactly the expected sidecar argv", () => {
    // An exact list, because an added --privileged or -p would otherwise pass.
    expect(sidecarDockerArgs({ id: "abc", sessionDir: "/s", uid: 501, gid: 20 })).toEqual([
      "run",
      "-d",
      "--name",
      "ccairgap-abc-network",
      "--label",
      "ccairgap.session=abc",
      "--network",
      "bridge",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--read-only",
      "--user",
      "501:20",
      "--tmpfs",
      "/tmp",
      "--tmpfs",
      "/ca:uid=501,gid=20,mode=700",
      "--memory=1g",
      "--log-driver",
      "json-file",
      "--log-opt",
      "max-size=10m",
      "--log-opt",
      "max-file=2",
      "-e",
      "HOME=/tmp",
      "-e",
      "PYTHONDONTWRITEBYTECODE=1",
      "-v",
      "ccairgap-abc-network:/run/ccairgap-network/sock",
      "-v",
      "/s/network/sidecar:/ccairgap:ro",
      "--entrypoint",
      "python3",
      NETWORK_SIDECAR_IMAGE,
      "/ccairgap/relay.py",
      "mitmdump",
      "--set",
      "confdir=/ca",
      "--set",
      "flow_detail=0",
      "--set",
      "termlog_verbosity=warn",
      "--set",
      "connection_strategy=lazy",
      "--set",
      "rawtcp=false",
      "--set",
      "http2=false",
      "--set",
      "http3=false",
      "--set",
      "onboarding=false",
      "--listen-host",
      "127.0.0.1",
      "--listen-port",
      "8080",
      "-s",
      "/ccairgap/policy.py",
    ]);
  });

  it("pins the image by digest", () => {
    expect(NETWORK_SIDECAR_IMAGE).toMatch(/^mitmproxy\/mitmproxy:[\d.]+@sha256:[0-9a-f]{64}$/);
  });

  it("points every client at the forwarder and one CA bundle", () => {
    const env = networkAgentEnv();
    expect(env.CCAIRGAP_NETWORK_POLICY).toBe("1");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:3128");
    expect(env.http_proxy).toBe(env.HTTP_PROXY);
    const proxy = "http://127.0.0.1:3128";
    const bundle = "/home/claude/.ccairgap-network-ca-bundle.pem";
    expect(env).toEqual({
      CCAIRGAP_NETWORK_POLICY: "1",
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      NO_PROXY: "localhost,127.0.0.1",
      no_proxy: "localhost,127.0.0.1",
      NODE_USE_ENV_PROXY: "1",
      NODE_EXTRA_CA_CERTS: bundle,
      SSL_CERT_FILE: bundle,
      CURL_CA_BUNDLE: bundle,
      GIT_SSL_CAINFO: bundle,
      REQUESTS_CA_BUNDLE: bundle,
      PIP_CERT: bundle,
      NPM_CONFIG_CAFILE: bundle,
      CODEX_CA_CERTIFICATE: bundle,
    });
  });
});

describe("credential hashes", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("accumulates hashes without duplicates and never stores the token", () => {
    dir = mkdtempSync(join(tmpdir(), "ccairgap-net-"));
    addCredentialHash(dir, "api.anthropic.com", "token-one");
    addCredentialHash(dir, "api.anthropic.com", "token-two");
    addCredentialHash(dir, "api.anthropic.com", "token-one");
    const text = readFileSync(
      join(dir, "network", "sidecar", "credentials", "api.anthropic.com"),
      "utf8",
    );
    expect(text).toBe(`${hashToken("token-one")}\n${hashToken("token-two")}\n`);
    expect(text).not.toContain("token-one");
  });

  it("hashes with SHA-256, because policy.py compares SHA-256", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("writes a 0600 file by replacing it, because the sidecar reads it on each request", () => {
    dir = mkdtempSync(join(tmpdir(), "ccairgap-net-"));
    addCredentialHash(dir, "h.test", "one");
    const credentials = join(dir, "network", "sidecar", "credentials");
    const dest = join(credentials, "h.test");
    const before = join(dir, "before");
    linkSync(dest, before);
    addCredentialHash(dir, "h.test", "two");
    // A write in place would also change the hard link.
    expect(readFileSync(before, "utf8")).toBe(`${hashToken("one")}\n`);
    expect(statSync(dest).mode & 0o777).toBe(0o600);
    expect(readdirSync(credentials)).toEqual(["h.test"]);
  });

  it("prefers the Codex API key over an access token", () => {
    expect(codexToken('{"OPENAI_API_KEY":"k","tokens":{"access_token":"t"}}')).toBe("k");
  });

  it("reads tokens from each credential format", () => {
    expect(claudeAccessToken('{"claudeAiOauth":{"accessToken":"a"}}')).toBe("a");
    expect(claudeAccessToken("{}")).toBeUndefined();
    expect(claudeAccessToken("not json")).toBeUndefined();
    expect(codexToken('{"OPENAI_API_KEY":"k"}')).toBe("k");
    expect(codexToken('{"tokens":{"access_token":"t"}}')).toBe("t");
    expect(codexToken("{}")).toBeUndefined();
  });
});

describe("summarizeDenials", () => {
  const line = (o: object) => JSON.stringify(o);

  it("counts denials and ignores allows and non-JSON lines", () => {
    const text = [
      "[12:00] some mitmproxy warning",
      line({ verdict: "allow", method: "GET", host: "a.com", port: 443, path: "/" }),
      line({ verdict: "deny", why: "no-matching-rule", method: "GET", host: "b.com", port: 443, path: "/x" }),
      line({ verdict: "deny", why: "no-matching-rule", method: "GET", host: "b.com", port: 443, path: "/x" }),
      line({ verdict: "deny", why: "no-matching-rule", method: "CONNECT", host: "c.com", port: 22 }),
    ].join("\n");
    const summary = summarizeDenials(text);
    expect(summary.total).toBe(3);
    expect(summary.lines).toEqual([
      "  2x GET b.com/x (no-matching-rule)",
      "  1x CONNECT c.com:22 (no-matching-rule)",
    ]);
  });

  it("removes terminal control bytes that the agent controls", () => {
    const summary = summarizeDenials(
      line({ verdict: "deny", why: "x", method: "GET", host: "a.com", path: "/\u001b[2J\u0007" }),
    );
    expect(summary.lines[0]).not.toMatch(/[\u001b\u0007]/);
  });

  it("removes control bytes from each field that the agent controls", () => {
    const esc = "\u001b[2J";
    const summary = summarizeDenials(
      line({ verdict: "deny", why: `w${esc}`, method: `G${esc}`, host: `h${esc}.test`, port: `8${esc}` }),
    );
    expect(summary.lines[0]).toBe("  1x G?[2J h?[2J.test:8?[2J (w?[2J)");
  });

  it("truncates a long field", () => {
    const summary = summarizeDenials(line({ verdict: "deny", why: "w", host: "h.test", path: `/${"a".repeat(300)}` }));
    expect(summary.lines[0]).toBe(`  1x h.test/${"a".repeat(159)}... (w)`);
  });

  it("limits the number of printed lines", () => {
    const text = Array.from({ length: 5 }, (_, i) =>
      line({ verdict: "deny", why: "x", host: `h${i}.com` }),
    ).join("\n");
    const summary = summarizeDenials(text, 2);
    expect(summary.total).toBe(5);
    expect(summary.lines).toHaveLength(3);
    expect(summary.lines[2]).toContain("3 more");
  });
});
