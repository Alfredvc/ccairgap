# Secrets and sensitive data

**Default posture: do not configure any secret flow.** The skill does not propose `-e <API_KEY>` pass-throughs, mounts of `.env` / `~/.ssh` / `~/.aws` / `~/.gcloud`, or any file that smells like a credential, unless the user has explicitly told you one is needed and named it.

This is not paranoia — it's scope. The user asks "configure ccairgap for this project"; they did not ask "and also thread my OpenAI key through it." Adding a secret flow they didn't ask for puts a credential somewhere it doesn't need to be and, more insidiously, hides the fact that they've started trusting an additional surface with it.

## When it *is* appropriate to wire one in

All of the following must hold:

1. The user explicitly asked, or a specific hook/MCP they asked to enable genuinely can't function without a credential.
2. You've named the credential to the user and they've confirmed.
3. You have a plan to pass it that does not involve committing the value to `config.yaml` or any other tracked file.

If any of those is uncertain, stop and ask.

## Safe passing patterns

### Env var pass-through (the default when a secret is needed)

Pass-through means the value lives only on the host at launch time; the container inherits it; nothing is written to disk in the repo:

```yaml
# config.yaml — safe to commit
docker-run-arg:
  - "-e OPENAI_API_KEY"
```

Note: `-e NAME` with **no** `=value`. Docker reads the value from the host environment at `docker run` time. The literal string `OPENAI_API_KEY` is the only thing in the repo.

At the CLI, equivalent:

```bash
ccairgap --docker-run-arg "-e OPENAI_API_KEY"
```

### Multi-secret ergonomics

If several secrets need to flow through, list them individually. Don't use `--env-file` pointing at a host `.env` — that implicitly binds whatever is in that file, including values the user may not realize are there.

```yaml
docker-run-arg:
  - "-e OPENAI_API_KEY"
  - "-e ANTHROPIC_API_KEY"
  - "-e GITHUB_TOKEN"
```

Tell the user which names you passed through and why.

## Patterns to avoid

### Do not commit literal values

```yaml
# NEVER do this — value lands in git.
docker-run-arg:
  - "-e OPENAI_API_KEY=sk-proj-..."
```

### Do not mount credential directories

```yaml
# NEVER do this by default. The container gains read access to every key
# on the host for this identity — most workflows never touch them.
ro:
  - ~/.ssh
  - ~/.aws
  - ~/.gcloud
```

If a specific workflow does need one (e.g. an MCP that clones over SSH), wire it narrowly and tell the user: "I'm giving the container read access to `~/.ssh/config` and one specific key — confirm." Use a named file inside `~/.ssh`, not the whole directory, when possible.

### Do not mount `.env` files

A host `.env` is convenient for the user but:

- It typically contains more than the container needs.
- Mounting it means every tool run in the container reads it on startup, including tools the user didn't realize would.

If the user says "just point it at my `.env`", push back: "I can pass individual variables through — which ones does this workflow actually need?"

### Do not read secrets during probing

Don't `cat` `.env`, `~/.aws/credentials`, `~/.ssh/id_rsa`, shell rc files, etc. during Phase 1 gathering. Your job is to configure ccairgap, not to enumerate the user's credentials. If a file name or content suggests a credential, leave it alone.

## What to tell the user

When you do wire in a secret flow, the user should hear three things from you:

1. Which credential you're passing and why (which hook/MCP needs it).
2. That it's pass-through — the value stays on the host, the config only names the variable.
3. That they need to ensure the variable is set in their host shell at launch, or the container will see an empty value.

That's it. No additional "for convenience I also added…" entries.
