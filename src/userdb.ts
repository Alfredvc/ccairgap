import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface UserdbInput {
  /** Absolute session dir; the userdb files land at `<sessionDir>/userdb/`. */
  sessionDir: string;
  /** Host UID the container runs as (matches `--user`). */
  uid: number;
  /** Host GID the container runs as. */
  gid: number;
  /** Container `$HOME` for the runtime user. */
  home: string;
}

export interface UserdbResult {
  /** Host path of the generated passwd file; bind-mount RO at `/etc/passwd`. */
  passwdPath: string;
  /** Host path of the generated group file; bind-mount RO at `/etc/group`. */
  groupPath: string;
}

/**
 * Generate per-session `/etc/passwd` and `/etc/group` files so libc lookups
 * for the runtime UID resolve to "claude" inside the container. Required
 * because the container is launched with `docker run --user <hostUid>:<hostGid>`,
 * and the baked image only has entries for the build-time UID 1000 — Node's
 * `os.userInfo()`, git's GECOS lookup, etc. throw when `getpwuid()` returns
 * NULL on a non-1000 host (macOS users typically 501).
 *
 * Files are RO-mounted at `/etc/passwd` and `/etc/group` (see `mounts.ts`).
 * Two minimal entries each: `root` (for any tooling that resolves UID 0) and
 * `claude` (the runtime UID). No shadow file — passwords are never queried in
 * the sandbox.
 */
export function writeUserdb(i: UserdbInput): UserdbResult {
  const dir = join(i.sessionDir, "userdb");
  mkdirSync(dir, { recursive: true });
  const passwdPath = join(dir, "passwd");
  const groupPath = join(dir, "group");
  // 7 fields: name:passwd:uid:gid:gecos:home:shell. Empty GECOS is fine; bash
  // and Node's os.userInfo only need name, uid, gid, home, shell to populate.
  const passwd = [
    "root:x:0:0:root:/root:/bin/bash",
    `claude:x:${i.uid}:${i.gid}::${i.home}:/bin/bash`,
    "",
  ].join("\n");
  // 4 fields: name:passwd:gid:members. Members empty — claude is its own primary group.
  const group = [
    "root:x:0:",
    `claude:x:${i.gid}:`,
    "",
  ].join("\n");
  writeFileSync(passwdPath, passwd, { mode: 0o644 });
  writeFileSync(groupPath, group, { mode: 0o644 });
  return { passwdPath, groupPath };
}
