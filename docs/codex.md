# Codex support

Codex is an opt-in selected agent surface:

```bash
ccairgap --agent codex --repo .
```

Claude remains the default. When Codex is selected, ccairgap validates the Codex workspace, args, expected image version, and selected auth before creating a session. Codex requires a workspace repo; `--agent codex --bare --repo <path>` is valid, but ro-only/no-repo launches and `--agent codex --bare` without `--repo` are rejected before side effects. `--resume` is currently Claude-only and is rejected for Codex before session creation.

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

Codex `--image` values are not auto-mounted. Each image path must already be container-visible through a workspace repo, `--ro`, `--cp`, `--sync`, `--mount`, or another ccairgap-controlled mount. Host-only paths fail before session creation.

## Host state preparation

Codex state preparation is session-local:

- Host `$CODEX_HOME` is resolved at launch time, or defaults to `~/.codex`, and the absolute host path is the value later recorded in manifests.
- `$CODEX_HOME/auth.json` is parsed and sanitized into `$SESSION/codex-auth/auth.json` with mode `0600` when safe.
- `$SESSION/codex-home/config.toml` is rewritten with a TOML parser and forces `cli_auth_credentials_store = "file"`.
- `$CODEX_HOME/plugins/cache/` and `$CODEX_HOME/.tmp/marketplaces/` are copied into `$SESSION/codex-home/` when present so configured Codex plugins can resolve inside the container. Symlinks are skipped; plugin runtime data under `$CODEX_HOME/plugins/data/` is not copied.
- `$SESSION/codex-sessions/` is created for container-local rollout records. During handoff or `recover`, ccairgap copies only validated rollout JSONL files back to `<manifest.codex.host_home>/sessions/`.

API-key file auth keeps only `OPENAI_API_KEY`. ChatGPT token file auth blanks `tokens.refresh_token` and requires a usable access token or fresh `last_refresh` inside ccairgap's safety buffer. `agent_identity`, keyring-only, ephemeral, missing, refresh-required, and unparsable token auth fail for selected Codex and are warning-only for advisory Codex state. Plan tier (Plus/Pro/Business/Enterprise/etc.) is not gated — OpenAI enforces plan policy server-side.

Codex auth is copied in, never copied out. Runtime writes to `auth.json`, logs, history, SQLite state, memories, themes, plugin data, and marketplace data remain session-local.

Codex rollout copy-out is manifest-driven. Handoff and `recover` use the launch-time `manifest.codex.host_home` value and do not rediscover the current host `CODEX_HOME`. Unsafe rollout trees, protected-path overlaps, symlinked destination parents, and changed destination collisions preserve the session for manual recovery instead of replacing host Codex data.

In print mode, `CODEX_API_KEY` from the host environment is forwarded into the container only for `--agent codex -p/--print`. That print-mode API key is enough selected auth for launch; any host `$CODEX_HOME/auth.json` is then treated as advisory state and is copied only if it passes the same sanitization checks.

## Runtime command

ccairgap sets `CCAIRGAP_AGENT=codex` and `CODEX_HOME=/home/claude/.codex` for the container. Interactive mode executes Codex through the unified entrypoint as `codex ...`; print mode executes `codex exec ...`. User passthrough tokens appear after the image tag in the Docker argv and are validated before Docker starts.

Before Docker execution, ccairgap resolves exact host Claude Code and Codex versions, computes an image tag that includes both versions, and inspects the resolved image for both agent binaries, the expected Claude Code and Codex versions, and required Codex mount targets. Explicit non-exact `CODEX_VERSION` values fail before pull or build because `latest` is not an image identity.

## `exec` command mode

`ccairgap exec --agent codex -- <command...>` prepares the Codex environment but runs the exact command after `--` instead of launching `codex`:

```bash
ccairgap exec --agent codex -- aharness recipe-driven-design.fsm.ts
```

Here `--agent codex` selects the staged environment and auth/config policy; it does not select the final command binary. The `--` separator is required, every following token is argv exactly, and ccairgap does no shell parsing. `--print` and `--resume` are rejected for `exec`; config `codex-args` is ignored with a warning because selected-agent passthrough is not used in command mode.

## Agent-aware subcommands

`ccairgap attach <id>` defaults to the agent recorded in the session manifest. Old manifests without `agent` default to Claude. `ccairgap attach --agent codex <id>` is allowed only when the running container exposes Codex state (`CODEX_HOME`), and its `--` tail is validated with the same interactive Codex passthrough allowlist documented above.

`ccairgap inspect --agent codex` reports sanitized Codex config, auth status, rollout session counts, and policy warnings. It never prints auth secret values or stripped external connection values.

`ccairgap doctor --agent codex` runs the shared host checks, resolves the same agent versions launch would use, reports the versioned image tag for those versions, and validates `$CODEX_HOME/auth.json` through the selected Codex auth sanitizer. It honors config/CLI `docker-build-arg` values and `CCAIRGAP_CC_VERSION`. It reports the auth kind, not the secret. Without `--agent`, doctor uses config `agent` and then falls back to Claude. If version resolution fails, doctor reports the image row failure instead of aborting the whole command.

## Config and guidance policy

Codex config is filtered rather than copied wholesale. ccairgap preserves unknown non-automation keys plus Codex `plugins` and `marketplaces` tables, disables file-defined MCP servers and hooks unless matched by explicit enable globs, and strips credential-routing or external-command keys such as custom providers, `openai_base_url`, `chatgpt_base_url`, profiles, telemetry, `notify`, app integrations, and MCP OAuth credential stores.

Project Codex overlays are limited to `AGENTS.md`, `AGENTS.override.md`, `.codex/config.toml`, `.codex/hooks.json`, `.codex/hooks/`, `.codex/skills/`, and `.agents/skills/`. Guidance-file symlinks for `AGENTS.md` and `AGENTS.override.md` are dereferenced and materialized as regular files after the same size, hardlink, executable, and UTF-8 checks as regular guidance files. Config and hook files are not copied when they are symlinks or fail those regular-file checks. Skill trees are copied more permissively: symlinked entries may be dereferenced, regular files are materialized as-is, and traversal-like names, `.git`, virtualenvs, `node_modules`, and hidden entries outside `.system/` are skipped. `.codex/hooks/` support files are copied with the stricter regular-file policy: hidden entries, symlinks, executables, hardlinks, oversized files, non-UTF-8 files, `.git`, virtualenvs, and `node_modules` are skipped. `.codex/rules/` and hidden skill files such as `.env` or `.credentials.json` are not copied. When an unsafe guidance/config/hook overlay file is skipped, the startup warning includes the skipped source path.
