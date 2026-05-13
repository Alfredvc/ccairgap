# Forwarding flags to the selected agent

Anything ccairgap doesn't own (`--model`, `--effort`, `--agents`, `--betas`, …) can be forwarded to the selected agent by writing it after `--`.

Claude remains the default selected agent. With `--agent claude`, the selected-agent tail is validated by Claude's denylist and then forwarded to Claude:

```bash
# Pin the model and bump effort
ccairgap --repo . -- --model opus --effort high

# Combine with --print to shape the output
ccairgap --print "summarize README" --repo . -- --output-format json --max-budget-usd 1
```

In config:

```yaml
claude-args:
  - --model
  - opus
  - --effort
  - high
```

Config and CLI are concatenated (config first, CLI appended); claude's last-wins arg parser handles duplicates, so `-- --model sonnet` from the CLI overrides a config `--model opus`.

When `--agent codex` or `agent: codex` is selected, the CLI `--` tail and config `codex-args` are merged in config-then-CLI order, validated with the Codex mode-aware allowlist, and forwarded to the in-container Codex invocation. See [codex.md](codex.md) for allowed Codex flags, denied surfaces, and `--image` visibility rules.

## Denylist

A small denylist blocks:

- Flags ccairgap owns: `--name`, `--resume`, `--print`.
- The resume family: `--continue`, `--from-pr`, …
- Host-path / policy-bypass flags: `--add-dir`, `--mcp-config`, `--settings`, …
- Pointless-in-container flags: `--help`, `--version`, `--chrome`.

Hard-denied flags abort launch with a one-line pointer at the ccairgap equivalent. `--dangerously-skip-permissions` is soft-dropped (already set by the entrypoint). Full denylist: [SPEC.md](SPEC.md) §"Selected-agent arg passthrough".
