import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { cliVersion } from "./version.js";

const AGENT_VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;
const EXACT_AGENT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const MANAGED_BASE_IMAGE_BUILD_ARG = "CCAIRGAP_BASE_IMAGE";
const MANAGED_RUNTIME_BASE_IMAGE_BUILD_ARG = "CCAIRGAP_RUNTIME_BASE_IMAGE";
const RUNTIME_STAGE_NAME = "ccairgap-runtime";

export interface ResolvedAgentVersions {
  claudeCodeVersion: string;
  codexVersion: string;
}

export interface AgentVersionHostReaders {
  claudeCodeVersion: () => Promise<string | undefined>;
  codexVersion: () => Promise<string | undefined>;
}

/** Release pins from the bundled `docker/agent-versions.env`. Missing keys are undefined. */
export interface PinnedAgentVersions {
  CLAUDE_CODE_VERSION?: string;
  CODEX_VERSION?: string;
}

export interface ImageBuildOptions {
  /** Absolute path to the Dockerfile to build. */
  dockerfile: string;
  /** Exact resolved agent versions used for image identity. */
  versions: ResolvedAgentVersions;
  /** docker build --build-arg values. */
  buildArgs: Record<string, string>;
  /** Force rebuild even if tag exists locally. */
  rebuild: boolean;
}

export interface ResolvedImage {
  tag: string;
  /** Absolute path to the directory containing the Dockerfile (docker build context). */
  contextDir: string;
  /** Absolute path to the Dockerfile itself. */
  dockerfile: string;
}

export interface CodexVersionValidation {
  ok: boolean;
  version?: string;
  message?: string;
}

/**
 * Resolve the default Dockerfile shipped with the package.
 * From dist/cli.js, package root is one up; docker/ lives alongside.
 */
export function defaultDockerfile(): string {
  return resolveBundledDockerAsset("Dockerfile");
}

/** Resolve the bundled entrypoint.sh shipped with the package. */
export function defaultEntrypoint(): string {
  return resolveBundledDockerAsset("entrypoint.sh");
}

export function resolveBundledDockerAsset(name: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const pkgRoot of [resolve(here, ".."), resolve(here)]) {
    const candidate = join(pkgRoot, "docker", name);
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      // try next
    }
  }
  throw new Error(`bundled docker/${name} not found alongside CLI`);
}

/**
 * Compute the image tag for a given Dockerfile path.
 *
 * Default path: `ccairgap:<cli-version>-<hash8>` where the hash covers the
 * Dockerfile, entrypoint.sh, and exact resolved agent versions. Edits to any
 * of those bake a new tag, so the rebuild-on-miss path auto-applies changes.
 * Stale `ccairgap:<v>-*` tags linger until the user prunes them — `ccairgap
 * doctor` surfaces them.
 *
 * Custom path (`--dockerfile`): `ccairgap:custom-<hash12>` over the Dockerfile,
 * exact resolved agent versions, and the managed base image identity when the
 * Dockerfile opts into `ARG CCAIRGAP_BASE_IMAGE` or
 * `ARG CCAIRGAP_RUNTIME_BASE_IMAGE`.
 */
function appendAgentVersionIdentity(
  hash: ReturnType<typeof createHash>,
  versions: ResolvedAgentVersions,
): void {
  hash.update(`\nCLAUDE_CODE_VERSION=${versions.claudeCodeVersion}`);
  hash.update(`\nCODEX_VERSION=${versions.codexVersion}`);
}

function computeDefaultTag(defaultPath: string, versions: ResolvedAgentVersions): string {
  const h = createHash("sha256");
  h.update(readFileSync(defaultPath));
  h.update(readFileSync(defaultEntrypoint()));
  appendAgentVersionIdentity(h, versions);
  return `ccairgap:${cliVersion()}-${h.digest("hex").slice(0, 8)}`;
}

function runtimeDockerfileIdentity(defaultPath: string): string {
  const content = readFileSync(defaultPath, "utf8");
  const finalStageMarker = `\nFROM ${RUNTIME_STAGE_NAME} AS ccairgap-final`;
  const finalStageIndex = content.indexOf(finalStageMarker);
  return finalStageIndex === -1 ? content : content.slice(0, finalStageIndex);
}

function computeRuntimeBaseTag(defaultPath: string): string {
  const h = createHash("sha256");
  h.update(runtimeDockerfileIdentity(defaultPath));
  h.update(readFileSync(defaultEntrypoint()));
  return `ccairgap:${cliVersion()}-runtime-${h.digest("hex").slice(0, 8)}`;
}

function dockerfileUsesBuildArg(content: Buffer | string, arg: string): boolean {
  return content.includes(arg);
}

export function computeTag(
  dockerfile: string,
  defaultPath: string,
  versions: ResolvedAgentVersions,
): string {
  if (resolve(dockerfile) === resolve(defaultPath)) {
    return computeDefaultTag(dockerfile, versions);
  }
  const content = readFileSync(dockerfile);
  const h = createHash("sha256");
  h.update(content);
  appendAgentVersionIdentity(h, versions);
  if (dockerfileUsesBuildArg(content, MANAGED_RUNTIME_BASE_IMAGE_BUILD_ARG)) {
    h.update(
      `\n${MANAGED_RUNTIME_BASE_IMAGE_BUILD_ARG}=${computeRuntimeBaseTag(defaultPath)}`,
    );
  }
  if (dockerfileUsesBuildArg(content, MANAGED_BASE_IMAGE_BUILD_ARG)) {
    h.update(`\n${MANAGED_BASE_IMAGE_BUILD_ARG}=${computeDefaultTag(defaultPath, versions)}`);
  }
  const hash = h.digest("hex").slice(0, 12);
  return `ccairgap:custom-${hash}`;
}

export function normalizeCodexVersion(output: string): string | undefined {
  return output.trim().match(AGENT_VERSION_PATTERN)?.[1];
}

export function normalizeClaudeVersion(output: string): string | undefined {
  return output.trim().match(AGENT_VERSION_PATTERN)?.[1];
}

function isExactAgentVersion(value: string): boolean {
  return EXACT_AGENT_VERSION_PATTERN.test(value);
}

function exactVersionError(key: string, value: string): string {
  return `${key} ${value} is not exact; pass an exact --docker-build-arg ${key}=x.y.z`;
}

function validateExactAgentVersion(key: string, value: string): string {
  if (!isExactAgentVersion(value)) {
    throw new Error(exactVersionError(key, value));
  }
  return value;
}

/**
 * Parse `KEY=VALUE` lines of `docker/agent-versions.env`. Blank lines and
 * `#` comments are ignored. The file stays shell-sourceable because the
 * release workflow `source`s it.
 */
export function parseAgentVersionsEnv(text: string): PinnedAgentVersions {
  const out: PinnedAgentVersions = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(CLAUDE_CODE_VERSION|CODEX_VERSION)\s*=\s*(\S+)\s*$/.exec(line);
    if (m) out[m[1] as keyof PinnedAgentVersions] = m[2];
  }
  return out;
}

/** Read the release pins shipped with the package. Empty when the file is unreadable. */
export function readPinnedAgentVersions(): PinnedAgentVersions {
  try {
    return parseAgentVersionsEnv(readFileSync(resolveBundledDockerAsset("agent-versions.env"), "utf8"));
  } catch {
    return {};
  }
}

/**
 * Resolve one agent version. Order: exact `--docker-build-arg`, then the
 * exact host binary version, then the bundled release pin. The pin covers
 * hosts that have only one of the two agents: the image always installs both,
 * and the agent missing on the host gets the release version.
 */
async function resolveAgentVersion(
  key: "CLAUDE_CODE_VERSION" | "CODEX_VERSION",
  explicitValue: string | undefined,
  hostVersion: () => Promise<string | undefined>,
  pinnedVersion: string | undefined,
): Promise<string> {
  if (explicitValue !== undefined) {
    return validateExactAgentVersion(key, explicitValue);
  }

  const resolved = await hostVersion();
  if (resolved !== undefined && isExactAgentVersion(resolved)) {
    return resolved;
  }

  if (pinnedVersion !== undefined && isExactAgentVersion(pinnedVersion)) {
    return pinnedVersion;
  }

  throw new Error(
    `${key} could not resolve: no exact host version and no exact release pin in docker/agent-versions.env; ` +
      `pass an exact --docker-build-arg ${key}=x.y.z`,
  );
}

export function validateExpectedCodexVersion(value: string): CodexVersionValidation {
  if (isExactAgentVersion(value)) {
    return { ok: true, version: value };
  }
  return {
    ok: false,
    message: exactVersionError("CODEX_VERSION", value),
  };
}

export function defaultImageBuildArgs(options: {
  claudeVersion: string;
  codexVersion: string;
  overrides?: Record<string, string>;
}): Record<string, string> {
  const buildArgs = {
    CLAUDE_CODE_VERSION: options.claudeVersion,
    CODEX_VERSION: options.codexVersion,
    ...(options.overrides ?? {}),
  };
  buildArgs.CLAUDE_CODE_VERSION = validateExactAgentVersion(
    "CLAUDE_CODE_VERSION",
    buildArgs.CLAUDE_CODE_VERSION,
  );
  buildArgs.CODEX_VERSION = validateExactAgentVersion("CODEX_VERSION", buildArgs.CODEX_VERSION);
  return buildArgs;
}

export async function resolveAgentVersions(
  buildArgs: Record<string, string> = {},
  hostReaders: AgentVersionHostReaders = {
    claudeCodeVersion: hostClaudeVersion,
    codexVersion: hostCodexVersion,
  },
  pinned: () => PinnedAgentVersions = readPinnedAgentVersions,
): Promise<ResolvedAgentVersions> {
  const pins = pinned();
  const claudeCodeVersion = await resolveAgentVersion(
    "CLAUDE_CODE_VERSION",
    buildArgs.CLAUDE_CODE_VERSION,
    hostReaders.claudeCodeVersion,
    pins.CLAUDE_CODE_VERSION,
  );
  const codexVersion = await resolveAgentVersion(
    "CODEX_VERSION",
    buildArgs.CODEX_VERSION,
    hostReaders.codexVersion,
    pins.CODEX_VERSION,
  );
  return { claudeCodeVersion, codexVersion };
}

export async function imageExistsLocally(tag: string): Promise<boolean> {
  try {
    await execa("docker", ["image", "inspect", tag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** docker build … -t <tag> -f <dockerfile> <contextDir> */
export async function buildImage(
  tag: string,
  contextDir: string,
  dockerfile: string,
  buildArgs: Record<string, string>,
  options: { target?: string } = {},
): Promise<void> {
  const args = ["build", "-t", tag, "-f", dockerfile];
  if (options.target !== undefined) {
    args.push("--target", options.target);
  }
  for (const [k, v] of Object.entries(buildArgs)) {
    args.push("--build-arg", `${k}=${v}`);
  }
  args.push(contextDir);
  await execa("docker", args, { stdio: "inherit" });
}

/**
 * Default registry repo for the published image. Override with
 * CCAIRGAP_REGISTRY for forks / mirrors / private registries.
 *
 * Versioned image tag derived from the local tag (`ccairgap:X-Y` →
 * `<registry>:X-Y`). Hash is deterministic from Dockerfile+entrypoint.sh
 * content plus exact agent versions, so a registry pull either matches
 * byte-for-byte or fails — there is no drift surface.
 */
export function registryRef(localTag: string): string | undefined {
  if (!localTag.startsWith("ccairgap:")) return undefined;
  const versionTag = localTag.slice("ccairgap:".length);
  // Custom Dockerfiles produce ccairgap:custom-<hash>; never published.
  if (versionTag.startsWith("custom-")) return undefined;
  const repo = process.env.CCAIRGAP_REGISTRY ?? "ghcr.io/alfredvc/ccairgap";
  return `${repo}:${versionTag}`;
}

/**
 * Try `docker pull <ref>` then `docker tag <ref> <localTag>`. Returns true on
 * success, false on any failure (offline, registry private, image not yet
 * published for this version+hash, etc.). Caller falls back to local build.
 */
export async function tryPullImage(localTag: string, ref: string): Promise<boolean> {
  try {
    await execa("docker", ["pull", ref], { stdio: "inherit" });
    await execa("docker", ["tag", ref, localTag], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Return image tag. Resolution order:
 *  1. Local image with matching tag → use it.
 *  2. `--rebuild` set → build locally, skip registry.
 *  3. Default Dockerfile (not `--dockerfile`) → try registry pull.
 *  4. Pull failed or custom Dockerfile → build locally.
 */
export async function ensureImage(opts: ImageBuildOptions): Promise<ResolvedImage> {
  const defaultPath = defaultDockerfile();
  const dockerfile = resolve(opts.dockerfile);
  const contextDir = dirname(dockerfile);
  const isDefaultDockerfile = resolve(dockerfile) === resolve(defaultPath);
  const dockerfileContent = readFileSync(dockerfile);
  const usesManagedRuntimeBaseImage =
    !isDefaultDockerfile &&
    dockerfileUsesBuildArg(dockerfileContent, MANAGED_RUNTIME_BASE_IMAGE_BUILD_ARG);
  const usesManagedBaseImage =
    !isDefaultDockerfile && dockerfileUsesBuildArg(dockerfileContent, MANAGED_BASE_IMAGE_BUILD_ARG);
  const tag = computeTag(dockerfile, defaultPath, opts.versions);

  if (!opts.rebuild && (await imageExistsLocally(tag))) {
    return { tag, contextDir, dockerfile };
  }
  if (!opts.rebuild) {
    const ref = registryRef(tag);
    if (ref !== undefined && (await tryPullImage(tag, ref))) {
      return { tag, contextDir, dockerfile };
    }
  }
  let buildArgs = opts.buildArgs;
  if (usesManagedRuntimeBaseImage) {
    const base = await ensureRuntimeBaseImage(defaultPath, opts.rebuild);
    buildArgs = {
      ...opts.buildArgs,
      [MANAGED_RUNTIME_BASE_IMAGE_BUILD_ARG]: base.tag,
    };
  } else if (usesManagedBaseImage) {
    const base = await ensureImage({
      dockerfile: defaultPath,
      versions: opts.versions,
      buildArgs: opts.buildArgs,
      rebuild: opts.rebuild,
    });
    buildArgs = {
      ...opts.buildArgs,
      [MANAGED_BASE_IMAGE_BUILD_ARG]: base.tag,
    };
  }
  await buildImage(tag, contextDir, dockerfile, buildArgs);
  return { tag, contextDir, dockerfile };
}

async function ensureRuntimeBaseImage(
  defaultPath: string,
  rebuild: boolean,
): Promise<ResolvedImage> {
  const dockerfile = resolve(defaultPath);
  const contextDir = dirname(dockerfile);
  const tag = computeRuntimeBaseTag(defaultPath);

  if (!rebuild && (await imageExistsLocally(tag))) {
    return { tag, contextDir, dockerfile };
  }
  if (!rebuild) {
    const ref = registryRef(tag);
    if (ref !== undefined && (await tryPullImage(tag, ref))) {
      return { tag, contextDir, dockerfile };
    }
  }
  await buildImage(tag, contextDir, dockerfile, {}, { target: RUNTIME_STAGE_NAME });
  return { tag, contextDir, dockerfile };
}

/** Best-effort: read Claude Code version inside the image. */
export async function readImageClaudeVersion(tag: string): Promise<string | undefined> {
  try {
    const { stdout } = await execa(
      "docker",
      ["run", "--rm", "--entrypoint", "claude", tag, "--version"],
      { timeout: 10_000 },
    );
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/** Best-effort: read Claude Code version from the host `claude` binary. */
export async function hostClaudeVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execa("claude", ["--version"], { timeout: 5_000 });
    return normalizeClaudeVersion(stdout);
  } catch {
    return undefined;
  }
}

/** Best-effort: read Codex version from the host `codex` binary. */
export async function hostCodexVersion(): Promise<string | undefined> {
  try {
    const { stdout } = await execa("codex", ["--version"], { timeout: 5_000 });
    return normalizeCodexVersion(stdout);
  } catch {
    return undefined;
  }
}
