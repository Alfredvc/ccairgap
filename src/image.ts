import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { cliVersion } from "./version.js";

export interface ImageBuildOptions {
  /** Absolute path to the Dockerfile to build. */
  dockerfile: string;
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

function resolveBundledDockerAsset(name: string): string {
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
 * Default path: `ccairgap:<cli-version>-<hash8>` where the hash covers both
 * the Dockerfile and entrypoint.sh content. Edits to either bake a new tag,
 * so the rebuild-on-miss path auto-applies changes. Stale `ccairgap:<v>-*`
 * tags linger until the user prunes them — `ccairgap doctor` surfaces them.
 *
 * Custom path (`--dockerfile`): `ccairgap:custom-<hash12>` over the
 * Dockerfile alone. User owns their entrypoint if any.
 */
export function computeTag(dockerfile: string, defaultPath: string): string {
  if (resolve(dockerfile) === resolve(defaultPath)) {
    const h = createHash("sha256");
    h.update(readFileSync(dockerfile));
    h.update(readFileSync(defaultEntrypoint()));
    return `ccairgap:${cliVersion()}-${h.digest("hex").slice(0, 8)}`;
  }
  const content = readFileSync(dockerfile);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 12);
  return `ccairgap:custom-${hash}`;
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
): Promise<void> {
  const args = ["build", "-t", tag, "-f", dockerfile];
  for (const [k, v] of Object.entries(buildArgs)) {
    args.push("--build-arg", `${k}=${v}`);
  }
  args.push(contextDir);
  await execa("docker", args, { stdio: "inherit" });
}

/** Return image tag, building if missing or if rebuild requested. */
export async function ensureImage(opts: ImageBuildOptions): Promise<ResolvedImage> {
  const defaultPath = defaultDockerfile();
  const dockerfile = resolve(opts.dockerfile);
  const contextDir = dirname(dockerfile);
  const tag = computeTag(dockerfile, defaultPath);

  const needsBuild = opts.rebuild || !(await imageExistsLocally(tag));
  if (needsBuild) {
    await buildImage(tag, contextDir, dockerfile, opts.buildArgs);
  }

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
    const match = stdout.trim().match(/(\d+\.\d+\.\d+(?:-\S+)?)/);
    return match?.[1];
  } catch {
    return undefined;
  }
}
