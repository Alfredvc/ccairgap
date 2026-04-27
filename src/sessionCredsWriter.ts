import {
  chmodSync,
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * Atomically replace `$sessionDir/creds/.credentials.json` with `json`.
 * Tmp file written + `fsync`'d, then `rename(2)`-swapped over the destination.
 * Mode 0600 on the new inode.
 *
 * Required by the runtime auth-refresh watcher: the directory bind-mount at
 * `/host-claude-creds-dir` survives a rename over the file inside it; the
 * earlier single-file mount did not.
 *
 * The pid + timestamp suffix on the tmp name is defense-in-depth — peer CLI
 * processes don't share a `$SESSION/creds/` dir today, so collision is already
 * impossible.
 */
export function writeSessionCreds(sessionDir: string, json: string): void {
  const dest = join(sessionDir, "creds", ".credentials.json");
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp.${process.pid}.${Date.now()}`;
  // mode applies at create only; the existing file's mode is irrelevant
  // because rename swaps the inode.
  writeFileSync(tmp, json, { mode: 0o600 });
  // Defense-in-depth: a future maintainer swapping in a writable stream
  // wouldn't honor the {mode} option.
  chmodSync(tmp, 0o600);
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dest);
}
