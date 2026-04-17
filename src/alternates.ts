import { existsSync, writeFileSync, rmSync, symlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Rewrite the session clone's `.git/objects/info/alternates` so git reads
 * historical objects from the RO-mounted host objects dir (at its container
 * path) instead of the host's real filesystem path. This keeps new commits in
 * the session clone's own RW `.git/objects/` while still reusing host storage
 * for history.
 */
export function writeAlternates(sessionClonePath: string, containerAlternatesPath: string): void {
  const infoDir = join(sessionClonePath, ".git", "objects", "info");
  mkdirSync(infoDir, { recursive: true });
  writeFileSync(join(infoDir, "alternates"), containerAlternatesPath + "\n");
}

/**
 * Point the session clone's LFS store at the RO-mounted host LFS objects.
 * Session's `.git/lfs/objects/` is replaced by a symlink to the container
 * mount path. Reads resolve transparently; writes (newly-added LFS objects)
 * fail against the RO target — acceptable for the threat model (host stays
 * untouched; user can add LFS objects by committing them as regular files
 * inside the sandbox if needed).
 */
export function pointLfsAtHost(
  sessionClonePath: string,
  containerLfsObjectsPath: string,
): void {
  const lfsObjects = join(sessionClonePath, ".git", "lfs", "objects");
  mkdirSync(dirname(lfsObjects), { recursive: true });
  if (existsSync(lfsObjects)) rmSync(lfsObjects, { recursive: true, force: true });
  symlinkSync(containerLfsObjectsPath, lfsObjects);
}
