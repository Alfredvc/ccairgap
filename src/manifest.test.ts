import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  manifestPath,
  readManifest,
  UnknownManifestVersionError,
  writeManifest,
  type Manifest,
} from "./manifest.js";

describe("manifest v1", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeSessionDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "ccairgap-manifest-"));
    tempDirs.push(dir);
    return dir;
  }

  it("writes representative v1 manifests as pretty JSON with a trailing newline", () => {
    const sessionDir = makeSessionDir();
    const manifest: Manifest = {
      version: 1,
      cli_version: "1.2.3",
      image_tag: "ccairgap:1.2.3",
      created_at: "2026-05-13T00:00:00.000Z",
      repos: [
        {
          basename: "ccairgap",
          host_path: "/Users/example/src/ccairgap",
          base_ref: "main",
          alternates_name: "ccairgap-1234abcd",
        },
      ],
      branch: "ccairgap/live-abcd",
      sync: [{ src_host: "dist", session_src: "/workspace/dist" }],
      claude_code: {
        host_version: "1.0.0",
        image_version: "1.0.0",
      },
    };

    writeManifest(sessionDir, manifest);

    const raw = readFileSync(manifestPath(sessionDir), "utf8");
    expect(raw).toBe(`${JSON.stringify(manifest, null, 2)}\n`);
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(manifest);
    expect(readManifest(sessionDir, "1.2.3")).toEqual(manifest);
  });

  it("reads older v1 manifests without additive optional fields unchanged", () => {
    const sessionDir = makeSessionDir();
    const manifest: Manifest = {
      version: 1,
      cli_version: "1.0.0",
      image_tag: "ccairgap:1.0.0",
      created_at: "2026-05-13T00:00:00.000Z",
      repos: [
        {
          basename: "ccairgap",
          host_path: "/Users/example/src/ccairgap",
        },
      ],
      claude_code: {},
    };
    writeFileSync(manifestPath(sessionDir), `${JSON.stringify(manifest, null, 2)}\n`);

    expect(readManifest(sessionDir, "1.2.3")).toEqual(manifest);
  });

  it("throws UnknownManifestVersionError for unsupported manifest versions", () => {
    const sessionDir = makeSessionDir();
    writeFileSync(
      manifestPath(sessionDir),
      `${JSON.stringify({ version: 2, cli_version: "2.0.0" }, null, 2)}\n`,
    );

    expect(() => readManifest(sessionDir, "1.2.3")).toThrow(UnknownManifestVersionError);
    expect(() => readManifest(sessionDir, "1.2.3")).toThrow(/manifest v2 is not supported/);
  });
});
