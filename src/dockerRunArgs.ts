import { parse as shellParse } from "shell-quote";

/**
 * Parse each `--docker-run-arg` value with shell-quote so users can write
 * `--docker-run-arg "-p 8080:8080"` and get `["-p", "8080:8080"]`. Rejects
 * non-literal shell constructs (operators, globs, subshells) — raw docker
 * args should be literal tokens.
 */
export function parseDockerRunArgs(rawValues: string[]): string[] {
  const out: string[] = [];
  for (const raw of rawValues) {
    const tokens = shellParse(raw);
    for (const t of tokens) {
      if (typeof t === "string") {
        out.push(t);
      } else {
        throw new Error(
          `--docker-run-arg: unsupported shell construct in "${raw}" (only literal tokens allowed)`,
        );
      }
    }
  }
  return out;
}

interface DangerousHit {
  token: string;
  reason: string;
}

/**
 * Best-effort scan for docker flags that weaken default container isolation.
 * Not exhaustive — users can always compose equivalent args we don't catch.
 * Goal is to nudge, not to block.
 */
export function scanDangerousArgs(tokens: string[]): DangerousHit[] {
  const hits: DangerousHit[] = [];
  const hostEqualFlags = new Set([
    "--network",
    "--net",
    "--pid",
    "--userns",
    "--ipc",
    "--uts",
  ]);

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;

    if (tok === "--privileged") {
      hits.push({ token: tok, reason: "grants all capabilities + device access" });
      continue;
    }
    if (tok.startsWith("--cap-add")) {
      hits.push({ token: tok, reason: "adds Linux capabilities" });
      continue;
    }
    if (tok.startsWith("--security-opt")) {
      hits.push({ token: tok, reason: "overrides security profile (apparmor/seccomp/etc.)" });
      continue;
    }
    if (tok.startsWith("--device")) {
      hits.push({ token: tok, reason: "exposes host device" });
      continue;
    }
    if (/=host$/.test(tok) && hostEqualFlags.has(tok.split("=")[0]!)) {
      hits.push({ token: tok, reason: "shares a host namespace" });
      continue;
    }
    if (hostEqualFlags.has(tok) && tokens[i + 1] === "host") {
      hits.push({ token: `${tok} host`, reason: "shares a host namespace" });
      i++;
      continue;
    }
    if (tok.includes("docker.sock")) {
      hits.push({ token: tok, reason: "grants docker daemon control" });
      continue;
    }
    if (tok.includes("SYS_ADMIN")) {
      hits.push({ token: tok, reason: "grants SYS_ADMIN capability" });
      continue;
    }
    if (tok === "--cap-drop" && tokens[i + 1] !== undefined && tokens[i + 1] !== "ALL") {
      hits.push({
        token: `${tok} ${tokens[i + 1]}`,
        reason: "narrows default cap-drop=ALL",
      });
      i++;
      continue;
    }
    if (tok.startsWith("--cap-drop=") && tok !== "--cap-drop=ALL") {
      hits.push({ token: tok, reason: "narrows default cap-drop=ALL" });
      continue;
    }
  }
  return hits;
}

export function formatDangerWarnings(hits: DangerousHit[]): string[] {
  return hits.map(
    (h) =>
      `ccairgap: warning: --docker-run-arg includes "${h.token}" — ${h.reason}. Container isolation is weaker than default. Suppress with --no-warn-docker-args.`,
  );
}
