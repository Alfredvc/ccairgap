# Forwarding flags to the selected agent

Anything ccairgap doesn't own (`--model`, `--effort`, `--agents`, `--betas`, …) can be forwarded to the selected agent by writing it after `--`.

Claude remains the default and is the only runtime-enabled agent in this build:

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

`--agent codex` and `codex-args` are accepted as staged configuration surfaces, but Codex launch is rejected before side effects until Codex runtime support lands. When `agent: codex` is selected, the CLI `--` tail is reserved for Codex passthrough instead of `claude-args`; the later Codex validation chunk defines which Codex tokens are allowed.

## Denylist

A small denylist blocks:

- Flags ccairgap owns: `--name`, `--resume`, `--print`.
- The resume family: `--continue`, `--from-pr`, …
- Host-path / policy-bypass flags: `--add-dir`, `--mcp-config`, `--settings`, …
- Pointless-in-container flags: `--help`, `--version`, `--chrome`.

Hard-denied flags abort launch with a one-line pointer at the ccairgap equivalent. `--dangerously-skip-permissions` is soft-dropped (already set by the entrypoint). Full denylist: [SPEC.md](SPEC.md) §"Selected-agent arg passthrough".
