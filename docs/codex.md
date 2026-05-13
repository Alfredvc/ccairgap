# Codex support

Codex is an opt-in selected agent surface:

```bash
ccairgap --agent codex --repo .
```

Codex runtime launch is still staged. In this build, `agent=codex` is parsed and Codex passthrough args are validated, then launch exits before session creation, Docker, auth copying, or handoff.

## Passthrough args

Tokens after `--` are validated for the selected agent. With `--agent codex`, ccairgap uses a fail-closed Codex allowlist instead of Claude's denylist. Config `codex-args` and the CLI `--` tail are merged in config-then-CLI order before validation.

Interactive Codex mode allows:

- `--image <file>` / `-i <file>`
- `--model <model>` / `-m <model>`
- `--search`
- `--no-alt-screen`
- one optional positional initial prompt

Print mode (`ccairgap --agent codex --print "..."`) allows:

- `--image <file>` / `-i <file>`
- `--model <model>` / `-m <model>`
- `--output-schema <schema>`
- `--color <auto|always|never>`
- `--output-last-message <file>` / `-o <file>`
- `--json`

Print mode does not accept an extra positional prompt after `--`; the prompt is the ccairgap `--print` value.

## Denied surfaces

Codex subcommands are not forwarded through selected-agent passthrough. This includes `exec`/`e`, `review`, `login`, `logout`, `mcp`, `plugin`, `mcp-server`, `app-server`, `remote-control`, `app`, `completion`, `update`, `sandbox`, `debug`, `execpolicy`, `apply`/`a`, `resume`, `fork`, `cloud`/`cloud-tasks`, `responses-api-proxy`, `stdio-to-uds`, `exec-server`, and `features`.

ccairgap also denies Codex flags that would bypass its container, config, approval, sandbox, or workspace policy: `--cd`/`-C`, `--add-dir`, `--config`/`-c`, `--profile`/`-p`, `--enable`, `--disable`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--remote`, `--remote-auth-token-env`, `--oss`, `--local-provider`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, and `--full-auto`.

In print mode, ccairgap also denies `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, and `--skip-git-repo-check`.

Unknown flags fail closed until they are reviewed against the supported Codex CLI source snapshot.

## Images

Codex `--image` values are not auto-mounted. Each image path must already be container-visible through a workspace repo, `--ro`, `--cp`, `--sync`, `--mount`, or another ccairgap-controlled mount. Host-only paths fail before the staged runtime-disabled message.

## Host state preparation

Codex state preparation is implemented but not wired into runtime launch until the later launch chunk. The prepared state is session-local:

- Host `$CODEX_HOME` is resolved at launch time, or defaults to `~/.codex`, and the absolute host path is the value later recorded in manifests.
- `$CODEX_HOME/auth.json` is parsed and sanitized into `$SESSION/codex-auth/auth.json` with mode `0600` when safe.
- `$SESSION/codex-home/config.toml` is rewritten with a TOML parser and forces `cli_auth_credentials_store = "file"`.
- `$SESSION/codex-home/sessions/` is created for container-local rollout records; host sessions are not copied back until the handoff chunk.

API-key file auth keeps only `OPENAI_API_KEY`. ChatGPT token file auth blanks `tokens.refresh_token` and requires a usable access token or fresh `last_refresh` inside ccairgap's safety buffer. `agent_identity`, keyring-only, ephemeral, missing, refresh-required, managed-eligible, unknown, and unparsable token auth fail for selected Codex and are warning-only for advisory Codex state.

Codex auth is copied in, never copied out. Runtime writes to `auth.json`, logs, history, SQLite state, memories, themes, plugin data, and marketplace data remain session-local.

## Config and guidance policy

Codex config is filtered rather than copied wholesale. ccairgap preserves unknown non-automation keys, disables MCP servers and hooks unless matched by explicit enable globs, strips credential-routing and external-connection keys such as custom providers, `openai_base_url`, `chatgpt_base_url`, profiles, telemetry, `notify`, plugin integrations, app integrations, and MCP OAuth credential stores.

Project Codex overlays are limited to `AGENTS.md`, `AGENTS.override.md`, `.codex/config.toml`, `.codex/hooks.json`, `.codex/skills/`, and `.agents/skills/`. Skill trees are bounded markdown guidance only. Symlinks, hardlinks, traversal-like paths, hidden credentials, oversized files, executable active files, `.codex/rules/`, `.codex/hooks/`, plugin integration state, and non-UTF-8 files are omitted.
