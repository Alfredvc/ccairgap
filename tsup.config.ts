import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  bundle: true,
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  shims: true,
  banner: { js: "#!/usr/bin/env node" },
  outExtension: () => ({ js: ".js" }),
});
