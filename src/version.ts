import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

let cached: string | undefined;

/** Read version from package.json sibling to the bundled dist/cli.js. */
export function cliVersion(): string {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  // dist/ is one level below package root; try ./package.json then ../package.json.
  for (const candidate of [join(here, "package.json"), join(here, "..", "package.json")]) {
    try {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
      if (pkg.version) {
        cached = pkg.version;
        return cached;
      }
    } catch {
      // try next
    }
  }
  cached = "0.0.0";
  return cached;
}
