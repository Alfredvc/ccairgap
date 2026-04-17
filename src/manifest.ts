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
      `manifest v${String(foundVersion)} is not supported by this claude-airlock (${cliVersion}). ` +
        `Upgrade claude-airlock or delete the session dir.`,
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
