# Secrets and sensitive data

The default is no secret flow. A request to configure ccairgap is not a request to give a sandboxed agent a key. An unrequested key also adds a place where the user now trusts the credential without knowing it.

## When to configure a secret

All of these must be true. If one is uncertain, stop and ask.

1. The user asked for it, or a hook or MCP server that the user asked for cannot run without it.
2. You named the credential to the user, and the user confirmed.
3. The value does not enter `config.yaml` or another tracked file.

## How to pass a secret

Pass each env var by name, with no `=value`. Docker reads the value from the host environment at launch, so only the name is in the repo.

```yaml
# Safe to commit.
docker-run-arg:
  - "-e OPENAI_API_KEY"
  - "-e GITHUB_TOKEN"
```

The CLI form is `ccairgap --docker-run-arg "-e OPENAI_API_KEY"`.

Under a [network policy](network.md), the agent can send a secret to any allowed host. Check the host list when you add a secret to a session with a policy.

## What to avoid

- **A literal value in config.** `-e OPENAI_API_KEY=sk-...` puts the secret in git.
- **`--env-file` with a host `.env`.** It passes everything in the file, including values that the user forgot.
- **A credential directory.** `ro: [~/.ssh]` gives the container every key on the host. If a workflow needs one key, mount that named file and tell the user: "I am giving the container read access to `~/.ssh/config` and one key. Confirm."
- **A mounted `.env`.** It holds more than the container needs, and every tool in the container can read it. If the user asks for this, ask which variables the workflow needs and pass those.

## What to tell the user

1. Which credential you pass, and which hook or server needs it.
2. That the value stays on the host, and the config holds only its name.
3. That the variable must be set in the host shell at launch. If it is not set, the container does not receive it.
