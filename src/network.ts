import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execa, execaSync } from "execa";
import type { AgentKind } from "./agent.js";
import { resolveBundledDockerAsset } from "./image.js";

/** Pinned by tag and index digest. No flag or env var changes this image. */
export const NETWORK_SIDECAR_IMAGE =
  "mitmproxy/mitmproxy:12.3.1@sha256:2711066c855659b5af8b1dbb84494ed3eff69b42ece439c60b4fe09a2db829d4";

/** Hosts where a token selects the account that receives the data. */
export const CREDENTIAL_HOSTS = ["api.anthropic.com", "chatgpt.com", "api.openai.com"] as const;

const AGENT_DIR = "/run/ccairgap-network/agent";
const SOCKET_DIR = "/run/ccairgap-network/sock";
// Under $HOME because a user mount can make /tmp read-only or share it across sessions.
const CA_BUNDLE = "/home/claude/.ccairgap-network-ca-bundle.pem";
const SIDECAR_READY_TIMEOUT_MS = 60_000;
const SIDECAR_MEMORY = "1g";

export interface NetworkRule {
  action: "allow" | "deny";
  host: string;
  /** An allow rule always has ports. A deny rule without ports covers every port. */
  ports?: number[];
  methods?: string[];
  paths?: string[];
}

export interface NetworkConfig {
  agentPreset: boolean;
  checkCredentials: boolean;
  rules: NetworkRule[];
}

export type CodexAuthKind = "api-key" | "chatgpt-token";

export interface NetworkPlan {
  /** User rules followed by preset rules. First match wins. */
  rules: NetworkRule[];
  userRuleCount: number;
  credentialHosts: string[];
}

function fail(path: string, message: string): never {
  throw new Error(`config.${path}: ${message}`);
}

function assertMap(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) fail(path, "expected map");
  return v as Record<string, unknown>;
}

function assertList(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, "expected list");
  if (v.length === 0) fail(path, "expected at least one entry. Omit the key to match everything");
  return v;
}

function parseHost(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, "expected string");
  const host = v.toLowerCase();
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) {
    fail(path, `invalid host '${v}'. Use an exact name or "*.example.com"`);
  }
  if (host.startsWith("*.") && !host.slice(2).includes(".")) {
    fail(path, `wildcard '${v}' covers a whole top-level domain`);
  }
  return host;
}

function parsePort(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 65535) {
    fail(path, "expected port number from 1 to 65535");
  }
  return v;
}

function parseMethod(v: unknown, path: string): string {
  if (typeof v !== "string" || !/^[A-Za-z]+$/.test(v)) fail(path, "expected HTTP method name");
  return v.toUpperCase();
}

function parsePathPattern(v: unknown, path: string): string {
  if (typeof v !== "string") fail(path, "expected string");
  if (!v.startsWith("/")) fail(path, `path '${v}' must start with "/"`);
  if (!/^[\x21-\x7e]+$/.test(v) || /[?#\\]/.test(v)) {
    fail(path, `path '${v}' holds a character that a request path cannot match`);
  }
  if (/%(?!2F)/.test(v)) {
    fail(path, `path '${v}' holds percent-encoding. Rules match decoded paths, so only %2F is valid`);
  }
  return v;
}

function parseRule(v: unknown, path: string): NetworkRule {
  const raw = assertMap(v, path);
  const rule: NetworkRule = { action: "allow", host: "" };
  for (const [key, val] of Object.entries(raw)) {
    const at = `${path}.${key}`;
    switch (key) {
      case "action":
        if (val !== "allow" && val !== "deny") fail(at, "expected allow or deny");
        rule.action = val;
        break;
      case "host":
        rule.host = parseHost(val, at);
        break;
      case "ports":
        rule.ports = assertList(val, at).map((p, i) => parsePort(p, `${at}[${i}]`));
        break;
      case "methods":
        rule.methods = assertList(val, at).map((m, i) => parseMethod(m, `${at}[${i}]`));
        break;
      case "paths":
        rule.paths = assertList(val, at).map((p, i) => parsePathPattern(p, `${at}[${i}]`));
        break;
      default:
        fail(at, "unknown key. Allowed: action, host, ports, methods, paths");
    }
  }
  if (!rule.host) fail(path, "host is required");
  if (rule.action === "allow" && !rule.ports) rule.ports = [443];
  return rule;
}

/**
 * Parses the `network` config key. A null value is an empty policy: presence of
 * the key activates enforcement, so a block whose rules are all commented out
 * must not turn into full outbound.
 */
export function parseNetworkConfig(v: unknown): NetworkConfig {
  const cfg: NetworkConfig = { agentPreset: true, checkCredentials: true, rules: [] };
  if (v === null || v === undefined) return cfg;
  const raw = assertMap(v, "network");
  for (const [key, val] of Object.entries(raw)) {
    const at = `network.${key}`;
    switch (key) {
      case "agent-preset":
      case "agentPreset":
        if (typeof val !== "boolean") fail(at, "expected boolean");
        cfg.agentPreset = val;
        break;
      case "check-credentials":
      case "checkCredentials":
        if (typeof val !== "boolean") fail(at, "expected boolean");
        cfg.checkCredentials = val;
        break;
      case "rules":
        if (val === null) break;
        if (!Array.isArray(val)) fail(at, "expected list");
        cfg.rules = val.map((r, i) => parseRule(r, `${at}[${i}]`));
        break;
      default:
        fail(at, "unknown key. Allowed: agent-preset, check-credentials, rules");
    }
  }
  return cfg;
}

/** Rules that the selected agent needs. Measured against real sessions; see docs/SPEC.md. */
export function agentPresetRules(agent: AgentKind, codexAuth?: CodexAuthKind): NetworkRule[] {
  if (agent === "claude") {
    return [
      {
        action: "allow",
        host: "api.anthropic.com",
        ports: [443],
        methods: ["GET", "POST"],
        paths: [
          "/v1/messages",
          "/v1/messages/count_tokens",
          "/v1/mcp_servers",
          "/api/web/domain_info",
        ],
      },
    ];
  }
  if (codexAuth === "api-key") {
    return [
      {
        action: "allow",
        host: "api.openai.com",
        ports: [443],
        methods: ["GET", "POST"],
        paths: ["/v1/responses"],
      },
    ];
  }
  return [
    {
      action: "allow",
      host: "chatgpt.com",
      ports: [443],
      methods: ["GET"],
      paths: [
        "/backend-api/codex/responses",
        "/backend-api/codex/models",
        "/backend-api/wham/accounts/check",
      ],
    },
  ];
}

export function planNetworkPolicy(
  config: NetworkConfig,
  agent: AgentKind,
  codexAuth?: CodexAuthKind,
): NetworkPlan {
  const preset = config.agentPreset ? agentPresetRules(agent, codexAuth) : [];
  return {
    rules: [...config.rules, ...preset],
    userRuleCount: config.rules.length,
    credentialHosts: config.checkCredentials ? [...CREDENTIAL_HOSTS] : [],
  };
}

function describeRule(rule: NetworkRule): string {
  const methods = rule.methods?.join(",") ?? "any method";
  const paths = rule.paths?.join(" ") ?? "any path";
  return `${rule.action} ${rule.host}:${rule.ports?.join(",") ?? "any port"} ${methods} ${paths}`;
}

/** Lines that the CLI prints to stderr at launch, so the user sees the active policy. */
export function formatNetworkPlan(plan: NetworkPlan): string[] {
  const lines = ["ccairgap: network policy active. First match wins, and no match denies."];
  plan.rules.forEach((rule, index) => {
    const origin = index < plan.userRuleCount ? "rule" : "preset";
    lines.push(`  ${origin}: ${describeRule(rule)}`);
  });
  if (plan.rules.length === 0) lines.push("  no rules: every request is denied");
  lines.push(`  credential check: ${plan.credentialHosts.length > 0 ? "on" : "off"}`);
  return lines;
}

const CONFLICTING_FLAGS = [
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
];

const VALUE_ONLY_FLAGS = ["-e", "--env", "--label", "-l"];

/** Host paths that a session mount must not expose. */
export interface NetworkProtectedPaths {
  /** Docker sockets. A socket on a read-only mount still accepts connections. */
  sockets: string[];
  /** Holds the policy, token hashes and addon of each session. */
  stateRoot?: string;
}

export function networkProtectedPaths(
  stateRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): NetworkProtectedPaths {
  const home = env.HOME ?? homedir();
  const candidates = [
    join(home, ".docker", "run", "docker.sock"),
    join(home, ".docker", "desktop", "docker.sock"),
    env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "docker.sock") : undefined,
    env.DOCKER_HOST?.startsWith("unix://") ? env.DOCKER_HOST.slice("unix://".length) : undefined,
  ];
  return {
    sockets: [
      "/var/run/docker.sock",
      "/run/docker.sock",
      ...candidates.filter((p): p is string => p !== undefined && existsSync(p)),
    ],
    stateRoot: existsSync(stateRoot) ? realpathSync(stateRoot) : stateRoot,
  };
}

function isSameOrInside(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p === "/" ? "/" : `${p}/`);
}

function exposesSocket(source: string, paths: NetworkProtectedPaths): boolean {
  return paths.sockets.some((socket) => isSameOrInside(source, socket));
}

function exposesState(source: string, paths: NetworkProtectedPaths): boolean {
  if (!paths.stateRoot) return false;
  return isSameOrInside(source, paths.stateRoot) || isSameOrInside(paths.stateRoot, source);
}

/** Returns the `--ro` and `--mount` paths that can bypass or change the policy. */
export function findNetworkPathConflicts(
  input: { ro: string[]; mount: string[] },
  paths: NetworkProtectedPaths,
): string[] {
  return [
    ...input.ro.filter((p) => exposesSocket(p, paths)),
    ...input.mount.filter((p) => exposesSocket(p, paths) || exposesState(p, paths)),
  ];
}

/** Returns the host source of a `-v` or `--mount` value, or undefined for a named volume. */
function mountSource(flag: "volume" | "mount", value: string): string | undefined {
  const source =
    flag === "volume"
      ? value.split(":")[0]
      : value
          .split(",")
          .map((field) => field.split("="))
          .find(([key]) => key === "src" || key === "source")?.[1];
  return source?.startsWith("/") ? source : undefined;
}

/**
 * Finds `--docker-run-arg` tokens that can bypass the proxy or weaken the
 * boundary around it. The scan covers known flags and is not a proof of
 * completeness; see docs/SPEC.md §"Conflicting docker args". `--add-host` and
 * `--dns*` stay allowed: they change name resolution only, and an agent with
 * only a loopback interface has no route to use them with.
 */
export function findNetworkConflicts(
  tokens: string[],
  paths: NetworkProtectedPaths = { sockets: [] },
): string[] {
  const conflicts: string[] = [];
  const exposes = (flag: "volume" | "mount", value: string): boolean => {
    const source = mountSource(flag, value);
    return source !== undefined && (exposesSocket(source, paths) || exposesState(source, paths));
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const next = tokens[i + 1];
    // An env or label value opens no route, even when it names a socket. A token
    // that starts with "-" is a flag, because a value-taking flag before it can
    // make docker read the "-e" here as a value.
    if (VALUE_ONLY_FLAGS.includes(token)) {
      if (next !== undefined && !next.startsWith("-")) i += 1;
      continue;
    }
    if (VALUE_ONLY_FLAGS.some((f) => token.startsWith(`${f}=`))) continue;
    if (token === "-v" || token === "--volume" || token === "--mount") {
      const flag = token === "--mount" ? "mount" : "volume";
      if (next !== undefined && !next.startsWith("-") && exposes(flag, next)) {
        conflicts.push(next);
        i += 1;
      }
      continue;
    }
    // -v=X, -vX and clusters of boolean short flags such as -dvX.
    const attached =
      /^(?:--volume=|-[ditq]*v=?)(.+)$/.exec(token)?.[1] ?? undefined;
    const attachedMount = /^--mount=(.+)$/.exec(token)?.[1] ?? undefined;
    if (
      token.includes("docker.sock") ||
      /ccairgap-(.*-)?network/.test(token) ||
      CONFLICTING_FLAGS.some((f) => token === f || token.startsWith(`${f}=`)) ||
      // -p, -P, -p80:80, and clusters of boolean short flags such as -dp or -qP.
      /^-[ditq]*[pP]/.test(token) ||
      (attached !== undefined && exposes("volume", attached)) ||
      (attachedMount !== undefined && exposes("mount", attachedMount))
    ) {
      conflicts.push(token);
    }
  }
  return conflicts;
}

/** Env vars for the agent container. Each one points a client at the forwarder or the CA bundle. */
export function networkAgentEnv(): Record<string, string> {
  const proxy = "http://127.0.0.1:3128";
  const noProxy = "localhost,127.0.0.1";
  return {
    CCAIRGAP_NETWORK_POLICY: "1",
    HTTPS_PROXY: proxy,
    HTTP_PROXY: proxy,
    https_proxy: proxy,
    http_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: "1",
    NODE_EXTRA_CA_CERTS: CA_BUNDLE,
    SSL_CERT_FILE: CA_BUNDLE,
    CURL_CA_BUNDLE: CA_BUNDLE,
    GIT_SSL_CAINFO: CA_BUNDLE,
    REQUESTS_CA_BUNDLE: CA_BUNDLE,
    PIP_CERT: CA_BUNDLE,
    NPM_CONFIG_CAFILE: CA_BUNDLE,
    CODEX_CA_CERTIFICATE: CA_BUNDLE,
  };
}

export function networkResourceName(id: string): string {
  return `ccairgap-${id}-network`;
}

function networkDir(sessionDir: string): string {
  return join(sessionDir, "network");
}

/** Mount arguments for the agent container. */
export function networkAgentDockerArgs(id: string, sessionDir: string): string[] {
  return [
    "--network",
    "none",
    "-v",
    `${join(networkDir(sessionDir), "agent")}:${AGENT_DIR}:ro`,
    "-v",
    `${networkResourceName(id)}:${SOCKET_DIR}:ro`,
  ];
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Adds a token hash to the allow set of a host. The file is replaced atomically
 * because the sidecar reads it on each request. Call this only with a token that
 * came from the host: the agent has RW on session credentials.
 */
export function addCredentialHash(sessionDir: string, host: string, token: string): void {
  const dir = join(networkDir(sessionDir), "sidecar", "credentials");
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, host);
  let existing = "";
  try {
    existing = readFileSync(dest, "utf8");
  } catch {
    // First hash for this host.
  }
  const hash = hashToken(token);
  if (existing.split("\n").includes(hash)) return;
  const tmp = `${dest}.tmp.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, `${existing}${hash}\n`, { mode: 0o600 });
  renameSync(tmp, dest);
}

/** Returns the OAuth access token from Claude credentials JSON. */
export function claudeAccessToken(json: string): string | undefined {
  try {
    const token = (JSON.parse(json) as { claudeAiOauth?: { accessToken?: unknown } }).claudeAiOauth
      ?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Returns the token from sanitized Codex auth JSON. */
export function codexToken(json: string): string | undefined {
  try {
    const obj = JSON.parse(json) as {
      OPENAI_API_KEY?: unknown;
      tokens?: { access_token?: unknown };
    };
    const token = obj.OPENAI_API_KEY ?? obj.tokens?.access_token;
    return typeof token === "string" && token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

/** Argv of the sidecar. The relay is PID 1 and supervises mitmproxy; see relay.py. */
function sidecarCommand(): string[] {
  const options = [
    "confdir=/ca",
    "flow_detail=0",
    "termlog_verbosity=warn",
    "connection_strategy=lazy",
    "rawtcp=false",
    "http2=false",
    "http3=false",
    "onboarding=false",
  ];
  return [
    "/ccairgap/relay.py",
    "mitmdump",
    ...options.flatMap((o) => ["--set", o]),
    "--listen-host",
    "127.0.0.1",
    "--listen-port",
    "8080",
    "-s",
    "/ccairgap/policy.py",
  ];
}

/** Builds the `docker run` argv of the sidecar. Exported for tests. */
export function sidecarDockerArgs(input: {
  id: string;
  sessionDir: string;
  uid: number;
  gid: number;
}): string[] {
  const name = networkResourceName(input.id);
  return [
    "run",
    "-d",
    "--name",
    name,
    "--label",
    `ccairgap.session=${input.id}`,
    "--network",
    "bridge",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--read-only",
    "--user",
    `${input.uid}:${input.gid}`,
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    `/ca:uid=${input.uid},gid=${input.gid},mode=700`,
    // The agent can send traffic at will. Without a limit, it could fill host memory.
    // The agent has no route if the kernel kills the sidecar at this limit.
    `--memory=${SIDECAR_MEMORY}`,
    // The agent can trigger log lines at will, so the log must have a bound.
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
    `${name}:${SOCKET_DIR}`,
    "-v",
    `${join(networkDir(input.sessionDir), "sidecar")}:/ccairgap:ro`,
    "--entrypoint",
    "python3",
    NETWORK_SIDECAR_IMAGE,
    ...sidecarCommand(),
  ];
}

function writeSessionFiles(sessionDir: string, plan: NetworkPlan): void {
  const sidecar = join(networkDir(sessionDir), "sidecar");
  const agent = join(networkDir(sessionDir), "agent");
  mkdirSync(join(sidecar, "credentials"), { recursive: true });
  mkdirSync(agent, { recursive: true });
  copyFileSync(resolveBundledDockerAsset("network/policy.py"), join(sidecar, "policy.py"));
  copyFileSync(resolveBundledDockerAsset("network/relay.py"), join(sidecar, "relay.py"));
  copyFileSync(resolveBundledDockerAsset("network/forwarder.mjs"), join(agent, "forwarder.mjs"));
  writeFileSync(
    join(sidecar, "policy.json"),
    JSON.stringify({ rules: plan.rules, credentialHosts: plan.credentialHosts }, null, 2) + "\n",
  );
}

async function ensureImage(): Promise<void> {
  const present = await execa("docker", ["image", "inspect", NETWORK_SIDECAR_IMAGE], {
    reject: false,
    stdio: "ignore",
  });
  if (present.exitCode === 0) return;
  console.error(`ccairgap: pulling ${NETWORK_SIDECAR_IMAGE}`);
  // Stdout of a print-mode session belongs to the agent, so progress goes to stderr.
  await execa("docker", ["pull", NETWORK_SIDECAR_IMAGE], { stdio: ["ignore", 2, 2] });
}

async function waitForSidecar(name: string, deadline: number): Promise<void> {
  const check = "test -S /run/ccairgap-network/sock/proxy.sock && test -s /ca/mitmproxy-ca-cert.pem";
  while (Date.now() < deadline) {
    const ready = await execa("docker", ["exec", name, "sh", "-c", check], { reject: false });
    if (ready.exitCode === 0) return;
    const running = await execa("docker", ["inspect", "-f", "{{.State.Running}}", name], {
      reject: false,
    });
    if (running.stdout.trim() !== "true") {
      const logs = await execa("docker", ["logs", "--tail", "20", name], { reject: false });
      throw new Error(`sidecar exited during startup: ${logs.stdout}\n${logs.stderr}`.trim());
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("sidecar was not ready before the timeout");
}

export interface DenialSummary {
  total: number;
  lines: string[];
}

/** Replaces bytes that could act on the host terminal. The agent controls these strings. */
function printable(value: unknown, max = 160): string {
  const text = String(value ?? "");
  const clean = text.replace(/[^\x20-\x7e]/g, "?");
  return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** Summarizes denied requests from sidecar log text. Exported for tests. */
export function summarizeDenials(logText: string, limit = 20): DenialSummary {
  const counts = new Map<string, number>();
  let total = 0;
  let numbered = 0;
  let lastSeq = 0;
  for (const line of logText.split("\n")) {
    if (!line.startsWith("{")) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (entry.verdict !== "deny") continue;
    total += 1;
    if (typeof entry.seq === "number") {
      numbered += 1;
      lastSeq = Math.max(lastSeq, entry.seq);
    }
    const method = entry.method ? `${printable(entry.method, 16)} ` : "";
    const port = entry.port && entry.port !== 443 ? `:${printable(entry.port, 8)}` : "";
    const path = entry.path ? printable(entry.path) : "";
    const key = `${method}${printable(entry.host, 120)}${port}${path} (${printable(entry.why, 40)})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const lines = sorted.slice(0, limit).map(([key, count]) => `  ${count}x ${key}`);
  if (sorted.length > limit) lines.push(`  and ${sorted.length - limit} more distinct requests`);
  const rotated = lastSeq - numbered;
  if (rotated > 0) lines.push(`  ${rotated} earlier denials are no longer in the sidecar log`);
  return { total: total + rotated, lines };
}

function printDenials(logText: string): void {
  const summary = summarizeDenials(logText);
  if (summary.total === 0) return;
  console.error(`ccairgap: network policy denied ${summary.total} requests:`);
  for (const line of summary.lines) console.error(line);
}

// `-v` also removes the anonymous volume that the mitmproxy image declares.
async function removeSidecarAndVolume(name: string): Promise<boolean> {
  await execa("docker", ["rm", "-f", "-v", name], { reject: false, stdio: "ignore" });
  for (let attempt = 0; attempt < 5; attempt++) {
    const removed = await execa("docker", ["volume", "rm", name], { reject: false, stdio: "ignore" });
    if (removed.exitCode === 0) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

export interface NetworkSidecarHandle {
  stop(opts: { keepContainer: boolean }): Promise<void>;
}

/**
 * Starts the sidecar and returns once the proxy accepts connections. On failure
 * this removes what it created and throws; the caller removes the session dir.
 */
export async function startNetworkSidecar(input: {
  id: string;
  sessionDir: string;
  plan: NetworkPlan;
}): Promise<NetworkSidecarHandle> {
  const name = networkResourceName(input.id);
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  try {
    writeSessionFiles(input.sessionDir, input.plan);
    await ensureImage();
    await execa("docker", ["volume", "create", name], { stdio: "ignore" });
    await execa(
      "docker",
      [
        "run",
        "--rm",
        "--network",
        "none",
        "--cap-drop=ALL",
        "--cap-add=CHOWN",
        "--security-opt=no-new-privileges",
        "--user",
        "0:0",
        "-v",
        `${name}:/v`,
        "--entrypoint",
        "chown",
        NETWORK_SIDECAR_IMAGE,
        `${uid}:${gid}`,
        "/v",
      ],
      { stdio: "ignore" },
    );
    await execa("docker", sidecarDockerArgs({ id: input.id, sessionDir: input.sessionDir, uid, gid }));
    await waitForSidecar(name, Date.now() + SIDECAR_READY_TIMEOUT_MS);
    const ca = await execa("docker", ["exec", name, "cat", "/ca/mitmproxy-ca-cert.pem"]);
    if (!ca.stdout.startsWith("-----BEGIN CERTIFICATE-----")) {
      throw new Error("sidecar returned an invalid CA certificate");
    }
    const caPath = join(networkDir(input.sessionDir), "agent", "ca.pem");
    writeFileSync(caPath, `${ca.stdout}\n`);
    chmodSync(caPath, 0o644);
  } catch (e) {
    await removeSidecarAndVolume(name);
    throw e;
  }

  let stopping = false;
  const watcher = execa("docker", ["wait", name], { reject: false });
  void watcher.then(() => {
    if (stopping) return;
    console.error(
      "\nccairgap: the network sidecar stopped. The agent has no network access for the rest of this session.",
    );
  });

  return {
    async stop({ keepContainer }) {
      stopping = true;
      const logs = await execa("docker", ["logs", name], {
        reject: false,
        stderr: "ignore",
        maxBuffer: 64 * 1024 * 1024,
      });
      printDenials(typeof logs.stdout === "string" ? logs.stdout : "");
      const removed = await removeSidecarAndVolume(name);
      watcher.kill();
      if (!removed) {
        const reason = keepContainer
          ? `--keep-container keeps the agent container, which still holds the volume. Remove it with: docker rm ccairgap-${input.id} && docker volume rm ${name}`
          : `Remove it with: docker volume rm ${name}`;
        console.error(`ccairgap: the network volume ${name} still exists. ${reason}`);
      }
    },
  };
}

/**
 * Removes a sidecar and volume that a SIGKILL or second signal to the CLI left behind. An agent
 * container still holds the volume, and later commands cannot find the volume
 * once the session dir is gone, so a failure names the command to run.
 */
export function removeLeftoverNetworkResources(id: string): void {
  const name = networkResourceName(id);
  execaSync("docker", ["rm", "-f", "-v", name], { reject: false, stdio: "ignore" });
  const present = execaSync("docker", ["volume", "inspect", name], { reject: false, stdio: "ignore" });
  if (present.exitCode !== 0) return;
  const removed = execaSync("docker", ["volume", "rm", name], { reject: false, stdio: "ignore" });
  if (removed.exitCode === 0) return;
  console.error(
    `ccairgap: the network volume ${name} still exists, because the agent container holds it. ` +
      `Remove them with: docker rm -f ccairgap-${id} && docker volume rm ${name}`,
  );
}
