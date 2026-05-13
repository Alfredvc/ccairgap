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
