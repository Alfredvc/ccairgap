import { join } from "node:path";

export interface ResolveUserWideDirInput {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  home: string;
}

/**
 * Resolve `~/.config/ccairgap/`. Honors `XDG_CONFIG_HOME` per the
 * XDG Base Directory Spec (empty value = unset).
 */
export function resolveUserWideDir(i: ResolveUserWideDirInput): string {
  const xdg = i.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(i.home, ".config");
  return join(base, "ccairgap");
}
