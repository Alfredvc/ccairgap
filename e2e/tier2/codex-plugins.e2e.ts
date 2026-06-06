import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import {
  mkTmpHome,
  seedGitRepo,
  seedClaudeHome,
  runCli,
  cleanupContainers,
} from "../helpers/env";
import { dockerAvailable } from "../helpers/dockerAvailable";
import { testCmd } from "../helpers/assertions";

const FAKE_DOCKERFILE = "e2e/fixtures/fake.Dockerfile";
const FAKE_AGENT_VERSIONS = [
  "--docker-build-arg=CLAUDE_CODE_VERSION=2.1.143",
  "--docker-build-arg=CODEX_VERSION=0.130.0",
];

describe.skipIf(!(await dockerAvailable()))("codex plugin state tier2", () => {
  let home: string;
  let ccairgapHome: string;
  let cleanup: () => Promise<void>;
  let repo: string;
  let sessionId: string | null;

  beforeEach(async () => {
    ({ home, ccairgapHome, cleanup } = await mkTmpHome());
    await seedClaudeHome(home);
    await seedHostCodexHome(home);
    repo = await seedGitRepo(home, "myapp");
    sessionId = null;
  });

  afterEach(async () => {
    if (sessionId) await cleanupContainers(sessionId);
    await cleanup();
  });

  it("mounts preserved plugin config and installed caches into container CODEX_HOME", async () => {
    const script = [
      "test \"$CODEX_HOME\" = \"/home/claude/.codex\"",
      "grep -F \"[plugins.\\\"sample@debug\\\"]\" \"$CODEX_HOME/config.toml\" >/dev/null",
      "grep -F \"[marketplaces.debug]\" \"$CODEX_HOME/config.toml\" >/dev/null",
      "! grep -F \"notify\" \"$CODEX_HOME/config.toml\" >/dev/null",
      "test -f \"$CODEX_HOME/plugins/cache/debug/sample/1.0.0/plugin.json\"",
      "grep -F \"sample-plugin\" \"$CODEX_HOME/plugins/cache/debug/sample/1.0.0/plugin.json\" >/dev/null",
      "test -f \"$CODEX_HOME/.tmp/marketplaces/debug/marketplace.json\"",
      "grep -F \"debug-marketplace\" \"$CODEX_HOME/.tmp/marketplaces/debug/marketplace.json\" >/dev/null",
      "test ! -e \"$CODEX_HOME/plugins/data/sample-debug/state.json\"",
      "exit 0",
    ].join(" && ");

    const result = await runCli(
      [
        "--agent", "codex",
        "--repo", repo,
        "--dockerfile", FAKE_DOCKERFILE,
        ...FAKE_AGENT_VERSIONS,
        "--no-preserve-dirty",
        "--print", "smoke",
        ...testCmd(script),
      ],
      { env: { HOME: home, CCAIRGAP_HOME: ccairgapHome } },
    );

    sessionId = result.sessionId;
    expect(
      result.exitCode,
      `codex plugin state was not staged into the container. ` +
        `stdout=${result.stdout} stderr=${result.stderr}`,
    ).toBe(0);
    expect(result.stderr).not.toContain("removed Codex config key 'plugins'");
    expect(result.stderr).not.toContain("removed Codex config key 'marketplaces'");
  });
});

async function seedHostCodexHome(home: string): Promise<void> {
  const codexHome = path.join(home, ".codex");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ OPENAI_API_KEY: "sk-e2e" }),
  );
  await fs.writeFile(
    path.join(codexHome, "config.toml"),
    `
notify = ["notify-send", "Codex"]

[plugins."sample@debug"]
enabled = true

[plugins."sample@debug".mcp_servers.sample]
enabled = true

[marketplaces.debug]
source_type = "local"
source = "/Users/me/debug-marketplace"
`,
  );

  const pluginRoot = path.join(codexHome, "plugins", "cache", "debug", "sample", "1.0.0");
  await fs.mkdir(pluginRoot, { recursive: true });
  await fs.writeFile(path.join(pluginRoot, "plugin.json"), '{"name":"sample-plugin"}\n');

  const marketplaceRoot = path.join(codexHome, ".tmp", "marketplaces", "debug");
  await fs.mkdir(marketplaceRoot, { recursive: true });
  await fs.writeFile(
    path.join(marketplaceRoot, "marketplace.json"),
    '{"name":"debug-marketplace"}\n',
  );

  const pluginDataRoot = path.join(codexHome, "plugins", "data", "sample-debug");
  await fs.mkdir(pluginDataRoot, { recursive: true });
  await fs.writeFile(path.join(pluginDataRoot, "state.json"), "{}\n");
}
