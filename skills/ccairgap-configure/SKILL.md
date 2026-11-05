---
name: ccairgap-configure
description: Configure `ccairgap`, the CLI that runs Claude Code or Codex with full permissions inside a Docker sandbox. Writes `.ccairgap/config.yaml`, profiles and custom Dockerfiles, and answers questions about them. Use whenever the user wants to set up ccairgap for a repo, add a binary, toolchain or MCP server to the sandbox, enable a hook, expose a sibling repo or a gitignored directory such as node_modules, keep build output, select Codex, pass an env var or a port, limit outbound network traffic, protect against data exfiltration, or asks "how do I make ccairgap do X". Use it also for ccairgap errors about config keys, mounts, hooks or a network policy, even if the user does not say "configure".
---

# ccairgap-configure

`ccairgap` runs an agent with full permissions in a Docker container. The container cannot change the host outside a small set of paths. Your job is to find what a workflow needs in that container, then write the smallest configuration that provides it.

The usual outputs are `.ccairgap/config.yaml` and `.ccairgap/Dockerfile`. A one-line CLI flag is the better answer when the user needs a setting for one session only.

## Workflow

Complete these phases in order. The user must be able to correct a proposal before any file exists.

### 1. Gather

Read `references/gathering-context.md` and run its probes. Probe with real commands instead of asking questions that a command can answer. Stay out of credential stores, because the user did not ask you to read them.

### 2. Align

State what you found and what you propose, and name what you left out. The omissions matter most, because the user cannot redirect a choice that they do not see. Wait for confirmation before you write a file.

> I see a Node/TypeScript project. `node_modules`, `.next` and `dist` are gitignored and exist on the host. Your settings have a `python3 ~/scripts/auto-approve.py` hook and a Playwright MCP server.
>
> Proposed:
> - `config.yaml`: `ro:` for `node_modules`, `.next` and `dist`, because the session clone does not contain them. `ro:` for `../shared-types`. Enable the `python3 *` hook.
> - `Dockerfile`: Playwright system libraries for the MCP server.
>
> Not added: write access to those directories, so `npm install` and `npm run build` fail in the sandbox. Tell me if you need them, and I will propose `cp` or `mount`. No port, no env var and no network policy.
>
> Confirm, or tell me what to change.

### 3. Produce

Write only what the user confirmed:

- **Config only.** Write `<git-root>/.ccairgap/config.yaml` directly.
- **Dockerfile, with no config yet.** Run `ccairgap init`. Then edit the two files that it writes.
- **Dockerfile, with a config already there.** Run `ccairgap init --config "$(mktemp -d)/config.yaml"` and copy the generated `Dockerfile` into `.ccairgap/`. A plain `init` refuses to run, and `init --force` overwrites the existing config.
- **A second policy or setup for one repo.** Write a profile at `.ccairgap/<name>.config.yaml`. The user selects it with `--profile <name>`.

Add a short comment that explains each key, because the user has to maintain the file. Delete every key and comment that the workflow does not use. Then run `ccairgap inspect` from the repo, or `ccairgap inspect --profile <name>` for a profile. It exits 1 on an unknown key or an invalid rule.

## Choose the surface

Read only the reference for the request at hand.

| The user wants | Surface | Read |
|---|---|---|
| A gitignored or sibling directory, a kept build result, or a write-enabled cache | `ro`, `extra-repo`, `cp`, `sync`, `mount` | `references/directories.md` |
| A binary, toolchain or package in the image | `dockerfile` | `references/dockerfile.md` |
| A hook to run in the sandbox | `hooks.enable` | `references/hooks.md` |
| An MCP server in the sandbox | `mcp.enable` | `references/mcp.md` |
| Less outbound traffic, or protection against exfiltration | `network` | `references/network.md` |
| A credential or API key | `docker-run-arg: ["-e NAME"]` | `references/secrets-and-sensitive-data.md` |
| A port, a Docker network, a resource limit | `docker-run-arg` | `references/docker-run-args.md` |
| Codex instead of Claude Code | `agent: codex` | `references/codex.md` |
| Flags for the agent itself, such as a model | `claude-args`, `codex-args` | `references/claude-args.md` |
| Instructions, settings or skills for sandbox sessions only | Files in `.ccairgap/` | `references/ccairgap-dir.md` |
| Automation in the sandbox with no agent | `ccairgap exec -- <command...>`, which has no config key | `references/config.md` |
| Any other key, path anchors, profiles, user-wide config | `config.yaml` | `references/config.md` |

Default to project config. Propose the user-wide layer in `~/.config/ccairgap/` only when the user asks for a setting in every project, because a user-wide key affects repos that you did not inspect.

Do not add a key that `references/config.md` does not list. If no key provides the behaviour, tell the user. A new key needs a change to ccairgap itself.

## Default to the least access

Each extra path, secret or flag gives an unattended agent more reach. So start from nothing and add only what the workflow needs or the user asks for.

- **Directories.** Default gitignored build and cache directories to `ro`. Escalate only when the user asks for writes or the workflow cannot run otherwise. The cost of a first run is not a reason to escalate.
- **Hooks and MCP servers.** ccairgap disables all of them by default. An enabled hook or server also needs its binary in the image and any env vars that it reads. Check both before you propose it.
- **`docker-run-arg`.** Propose this only when the user describes a need that maps to it, such as "expose port 5173". Delete a line that you added because it might be useful.
- **Secrets.** Configure a secret only when the user names it, or when a hook or server that the user asked for cannot run without it. Use `-e NAME` so that the value stays out of the repo.
- **Isolation flags.** Do not recommend `--privileged`, `--cap-add`, `--pid=host`, `--network=host`, `--device` or a `docker.sock` mount to make something work. These remove the isolation that the user installed ccairgap to get. If the user asks for one, say that and wait. If a workflow cannot run in the sandbox, say that too.
- **Network policy.** A session has full outbound access by default, and the policy is opt-in. Propose a `network` block only when the user asks about outbound traffic or exfiltration, or when the user's description of the repo gives a reason. Otherwise name it as "not added".

## Propose a network policy

Build the rule list from the needs that you found in Phase 1, because each allowed host is a route for data:

1. Start from `network: {}`, which allows only the agent's own API.
2. Add one rule for each host that the workflow needs. Use the host table in `references/network.md`.
3. Set `methods: [GET]` when the workflow only reads. Add `paths` when the workflow needs one part of a host.
4. Tell the user what the policy does not stop. At minimum, say that an agent can send data in a request to any allowed host, including its own API.
5. Remove `-p`, `--network` and other flags that the policy rejects, and tell the user. Publish a port or join a Docker network only in a config without a `network` key.
6. Tell the user to check the launch output for the "network policy active" line, and to read the denials in the exit summary.

## Common traps

- **Absolute paths in committed config.** Use relative paths, because absolute paths do not transfer to other people. The keys use different anchors, so check "Path resolution" in `references/config.md`.
- **A persistent `~/.claude/`.** ccairgap copies it into the session, and session changes end with the container. Users who ask to persist it usually need a `.ccairgap/` file or a host config change.
- **`cp` and Docker's `COPY`.** `cp` copies a host path into the session at launch. `COPY` bakes files into the image.
- **A replaced base image.** Keep the `FROM` lines that `ccairgap init` generates, because they provide the UID handling, the entrypoint and the mount targets.
