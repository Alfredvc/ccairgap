import { createHash } from "node:crypto";

/**
 * Unique, filesystem-safe segment for per-repo scratch paths: the
 * `/host-git-alternates/<alternatesName>/…` Docker mount, the session clone
 * directory (`$SESSION/repos/<alternatesName>`), and the hook/MCP policy scratch
 * dir (`$SESSION/policy/hooks|mcp/projects/<alternatesName>`).
 *
 * Two repos sharing a `basename(hostPath)` would otherwise collide on all
 * three. The 8-hex slice of sha256(hostPath) disambiguates while the leading
 * basename keeps logs readable.
 */
export function alternatesName(basename: string, hostPath: string): string {
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, "_");
  const hash = createHash("sha256").update(hostPath).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}
