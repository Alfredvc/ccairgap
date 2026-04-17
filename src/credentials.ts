import { existsSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { hostClaudeDir } from "./paths.js";

const KEYCHAIN_ITEM = "Claude Code-credentials";

export interface CredentialSource {
  /** Absolute path to the file that should be bind-mounted at /host-claude-creds. */
  hostPath: string;
  /** Human-readable origin for doctor / logs. */
  origin: "keychain" | "file";
}

/**
 * Resolve the host credentials file for a session.
 * macOS: dump keychain JSON to $sessionDir/creds/.credentials.json (0600), return that path.
 * Others: return ~/.claude/.credentials.json if it exists.
 * Throws with a user-facing message if credentials cannot be resolved.
 */
export async function resolveCredentials(sessionDir: string): Promise<CredentialSource> {
  if (platform() === "darwin") {
    let json: string;
    try {
      const { stdout } = await execa("security", [
        "find-generic-password",
        "-w",
        "-s",
        KEYCHAIN_ITEM,
      ]);
      json = stdout;
    } catch (e) {
      throw new Error(
        `cannot read Claude Code credentials from macOS keychain (${(e as Error).message.split("\n")[0]}). ` +
          `Run \`claude\` on the host to log in, then unlock the login keychain.`,
      );
    }
    // Validate it's JSON with the expected shape so we fail early on corruption.
    try {
      const parsed = JSON.parse(json) as { claudeAiOauth?: unknown };
      if (!parsed.claudeAiOauth) {
        throw new Error("keychain item missing claudeAiOauth field");
      }
    } catch (e) {
      throw new Error(`keychain credentials are not valid JSON: ${(e as Error).message}`);
    }

    const credsPath = join(sessionDir, "creds", ".credentials.json");
    mkdirSync(dirname(credsPath), { recursive: true });
    writeFileSync(credsPath, json);
    chmodSync(credsPath, 0o600);
    return { hostPath: credsPath, origin: "keychain" };
  }

  const linuxPath = join(hostClaudeDir(), ".credentials.json");
  if (!existsSync(linuxPath)) {
    throw new Error(
      `host credentials missing at ${linuxPath}. Run \`claude\` on the host to log in.`,
    );
  }
  return { hostPath: linuxPath, origin: "file" };
}

/** Non-throwing variant for doctor. Returns null on failure with a reason. */
export async function probeCredentials(): Promise<{ ok: boolean; detail: string }> {
  if (platform() === "darwin") {
    try {
      const { stdout } = await execa("security", [
        "find-generic-password",
        "-w",
        "-s",
        KEYCHAIN_ITEM,
      ]);
      JSON.parse(stdout);
      return { ok: true, detail: `macOS keychain (${KEYCHAIN_ITEM})` };
    } catch (e) {
      return {
        ok: false,
        detail: `keychain read failed: ${(e as Error).message.split("\n")[0]}`,
      };
    }
  }
  const p = join(hostClaudeDir(), ".credentials.json");
  return existsSync(p)
    ? { ok: true, detail: p }
    : { ok: false, detail: `missing at ${p} — run \`claude\` to log in` };
}
