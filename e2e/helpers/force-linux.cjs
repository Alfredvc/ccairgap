// Test-only preload. Loaded via NODE_OPTIONS=--require in tier2 tests so the
// spawned ccairgap CLI sees process.platform === "linux" on macOS hosts. This
// avoids the macOS keychain branch in credentials.ts — tier2 seeds a file
// ~/.claude/.credentials.json, which is the Linux source path. os.platform()
// returns process.platform, so overwriting the property covers both callsites.
Object.defineProperty(process, "platform", { value: "linux" });
