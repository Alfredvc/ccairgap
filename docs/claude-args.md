# Forwarding flags to claude

Anything ccairgap doesn't own (`--model`, `--effort`, `--agents`, `--betas`, …) can be forwarded to `claude` inside the container by writing it after `--`:

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

## Denylist

A small denylist blocks:

- Flags ccairgap owns: `--name`, `--resume`, `--print`.
- The resume family: `--continue`, `--from-pr`, …
- Host-path / policy-bypass flags: `--add-dir`, `--mcp-config`, `--settings`, …
- Pointless-in-container flags: `--help`, `--version`, `--chrome`.

Hard-denied flags abort launch with a one-line pointer at the ccairgap equivalent. `--dangerously-skip-permissions` is soft-dropped (already set by the entrypoint). Full denylist: [SPEC.md](SPEC.md) §"Claude arg passthrough".
