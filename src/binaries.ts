import { execa } from "execa";

export interface HostBinaryCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * Probe whether `name` is resolvable via PATH using POSIX `command -v`.
 * Avoids `<bin> --version` because BSD `cp` has no such flag.
 */
export async function checkHostBinary(name: string): Promise<HostBinaryCheck> {
  try {
    const { stdout } = await execa("sh", ["-c", `command -v ${name}`], { timeout: 3_000 });
    return { name, ok: true, detail: stdout.trim() || "found on PATH" };
  } catch {
    return { name, ok: false, detail: "not found on PATH" };
  }
}

/**
 * Fail-fast preflight for launch. Verifies every listed binary is resolvable
 * before any session-dir side effects. Throws a single aggregated error on
 * the first missing binary so the user sees a clean message instead of a
 * mid-pipeline execa ENOENT.
 */
export async function requireHostBinaries(names: string[]): Promise<void> {
  const results = await Promise.all(names.map((n) => checkHostBinary(n)));
  const missing = results.filter((r) => !r.ok).map((r) => r.name);
  if (missing.length > 0) {
    throw new Error(
      `required host binaries missing on PATH: ${missing.join(", ")}. ` +
        `Install them and retry (run \`ccairgap doctor\` for a full preflight).`,
    );
  }
}
