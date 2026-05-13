import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

export type CodexHomeSource = "env" | "default";

export interface CodexHomePlan {
  hostHome: string;
  source: CodexHomeSource;
}

export class UnsafeCodexHomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeCodexHomeError";
  }
}

function isSameOrDescendant(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function resolveCodexHome(options: {
  env?: NodeJS.ProcessEnv;
  protectedHostPaths?: string[];
} = {}): CodexHomePlan {
  const env = options.env ?? process.env;
  const source: CodexHomeSource = env.CODEX_HOME ? "env" : "default";
  const rawHome = env.CODEX_HOME ?? join(env.HOME ?? homedir(), ".codex");
  const hostHome = resolve(rawHome);

  for (const rawProtected of options.protectedHostPaths ?? []) {
    const protectedPath = resolve(rawProtected);
    if (isSameOrDescendant(hostHome, protectedPath)) {
      throw new UnsafeCodexHomeError(
        `CODEX_HOME ${hostHome} is inside protected workspace ${protectedPath}`,
      );
    }
  }

  return { hostHome, source };
}
