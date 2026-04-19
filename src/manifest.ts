import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MANIFEST_VERSION = 1 as const;

export interface ManifestV1 {
  version: 1;
  cli_version: string;
  image_tag: string;
  created_at: string;
  repos: Array<{
    basename: string;
    host_path: string;
    base_ref?: string;
  }>;
  /**
   * Sandbox branch name used in the session clones (e.g. `ccairgap/<id>`).
   * Optional for v1 back-compat: pre-existing sessions written by an older CLI
   * (which used the `sandbox/` prefix) without this field fall back to
   * `sandbox/<id>` in handoff/orphan scanning so their work is not lost.
   */
  branch?: string;
  /**
   * --sync entries recorded at launch so the exit-trap / recover handoff knows
   * which in-session paths to rsync back out to $CCAIRGAP_HOME/output/<id>/.
   * Additive field (optional): pre-existing v1 sessions without it recover fine.
   */
  sync?: Array<{ src_host: string; session_src: string }>;
  claude_code: {
    host_version?: string;
    image_version?: string;
  };
}

export type Manifest = ManifestV1;

const SUPPORTED_VERSIONS = new Set<number>([MANIFEST_VERSION]);

export class UnknownManifestVersionError extends Error {
  constructor(public readonly foundVersion: unknown, public readonly cliVersion: string) {
    super(
      `manifest v${String(foundVersion)} is not supported by this ccairgap (${cliVersion}). ` +
        `Upgrade ccairgap or delete the session dir.`,
    );
    this.name = "UnknownManifestVersionError";
  }
}

export function manifestPath(sessionDirPath: string): string {
  return join(sessionDirPath, "manifest.json");
}

export function writeManifest(sessionDirPath: string, m: Manifest): void {
  writeFileSync(manifestPath(sessionDirPath), JSON.stringify(m, null, 2) + "\n");
}

export function readManifest(sessionDirPath: string, cliVersion: string): Manifest {
  const raw = readFileSync(manifestPath(sessionDirPath), "utf8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "number" || !SUPPORTED_VERSIONS.has(parsed.version)) {
    throw new UnknownManifestVersionError(parsed.version, cliVersion);
  }
  return parsed as Manifest;
}
