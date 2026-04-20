import { existsSync } from "node:fs";
import { join } from "node:path";

export interface ResolveManagedPolicyInput {
  /** Host OS. Pass `os.platform()` in production. */
  platform: NodeJS.Platform;
  /**
   * Filesystem root. Defaults to `/` so production calls produce absolute
   * paths. Tests inject a tmp dir to keep assertions sandbox-local.
   */
  root?: string;
}

/**
 * Locate the host's Claude Code managed-policy directory (macOS:
 * `/Library/Application Support/ClaudeCode/`, Linux: `/etc/claude-code/`).
 * Returns `undefined` when:
 *  - the directory is absent (most non-enterprise users),
 *  - the host OS is Windows or any other non-POSIX platform.
 *
 * Mirrors `claude-code/src/utils/settings/managedPath.ts:8-23`. ccairgap
 * mounts the returned directory RO at the fixed container path
 * `/etc/claude-code/` regardless of host OS — the in-container Claude
 * binary always runs Linux.
 */
export function resolveManagedPolicyDir(i: ResolveManagedPolicyInput): string | undefined {
  const root = i.root ?? "/";
  let hostPath: string;
  switch (i.platform) {
    case "darwin":
      hostPath = join(root, "Library", "Application Support", "ClaudeCode");
      break;
    case "linux":
      hostPath = join(root, "etc", "claude-code");
      break;
    default:
      return undefined;
  }
  return existsSync(hostPath) ? hostPath : undefined;
}
