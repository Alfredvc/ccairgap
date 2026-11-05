# Gathering context

Run these probes before you recommend anything, in parallel when you can. Ask the user only what a command cannot answer.

## Repo shape

```bash
git rev-parse --show-toplevel          # workspace repo root
git status --porcelain                 # work in progress
ls -a "$(git rev-parse --show-toplevel)/.ccairgap" 2>/dev/null   # existing config and profiles
```

If an existing config is present, read it and propose changes to it. If `.gitmodules` exists, warn the user that private submodules do not initialize in the container.

## Project type and binaries

Read the manifest at the repo root: `package.json`, `pyproject.toml`, `requirements.txt`, `Cargo.toml`, `go.mod`, `Gemfile`, `pom.xml`, `build.gradle` or `Podfile`. The project type selects the directories to check in `directories.md`.

Build a list of the binaries that the workflow runs, from these sources:

- `command` fields of hooks and MCP servers in the `ccairgap inspect` output. These often name `uv`, `npx` or `python3`.
- `scripts` and dependencies in the manifest, such as Playwright, Puppeteer, Prisma or Cypress.
- `.tool-versions`, `.nvmrc` and `.python-version`, for version pins.
- CI config such as `.github/workflows/*.yml`. The container often needs what CI needs.

Compare the list with "What the default image already has" in `dockerfile.md`. Each binary that is not there is a Dockerfile candidate.

## Directories

Follow "The gitignore rule" in `directories.md` for each directory of this project type.

Then look for material outside the repo. These sources show that a session will read a sibling directory:

- `paths` or `references` in `tsconfig.json` that leave the repo.
- `path = "..."` dependencies in `Cargo.toml`.
- `replace` directives in `go.mod`.
- `[tool.<x>.sources]` in `pyproject.toml`.
- Companion repos named in `README.md` or `CONTRIBUTING.md`.

If the answer is unclear, list the sibling directories and ask which ones the session needs.

## Agent setup

Run `ccairgap inspect`. Use `--repo` and `--extra-repo` to match the launch that you configure, and `--agent codex` when the user selects Codex. One call covers user, project and plugin sources. A manual walk of the config files misses plugin hooks and plugin MCP servers.

```bash
ccairgap inspect
ccairgap inspect --repo <path> --extra-repo <p2>
ccairgap inspect --agent codex
```

The JSON output has these arrays:

- `hooks[]`: `{source, sourcePath, event, matcher?, command, plugin?, repo?}`.
- `mcpServers[]`: `{source, sourcePath, name, definition, plugin?, repo?, projectPath?, approvalState?}`. `definition` is the raw server object. `approvalState` on a project server is `approved`, `denied` or `unapproved`.
- `env[]`: `{source, sourcePath, name, value, repo?}`. These are the env vars that ccairgap injects into the agent.
- `marketplaces[]`: `{source, sourcePath, name, entry, sourceType?, hostPath?, repo?}`. ccairgap mounts a `directory` or `file` marketplace automatically, so it needs no config.

Managed-settings tiers are not in the output, because ccairgap does not mount them.

Flag these items for the user:

- A hook or server `command` that names a host-only path such as `~/scripts/...` or `/opt/homebrew/bin/...`. It needs a Dockerfile entry, or it stays disabled.
- A server with `approvalState: unapproved`. It does not run in the sandbox until the user approves it on the host.
- An `env` value with a host-only path. It does not resolve in the container.
- `statusLine.command` in the user's settings. It runs by default. It fails with no message if its binaries are not in the image.

If `inspect` does not exist, the installed ccairgap is old. Tell the user to upgrade, because a manual walk gives incomplete results.

## Network

Find out whether the session should reach the whole internet. Ask this only if the user mentioned outbound traffic, exfiltration or untrusted input, or if the repo holds data that the user says must stay private. Then ask: "Which hosts must the session reach, and does it need to write to any of them?"

Collect the candidates for the answer from the probes above:

- Package registries, from the manifest.
- The git host, from `git remote -v`. A policy blocks `ssh` remotes, so report any that you find.
- HTTP MCP servers, from `definition.url` in the `ccairgap inspect` output.
- Docker flags in an existing config that a policy rejects. See "Conflicting docker args" in `network.md`.

Then follow "Propose a network policy" in `SKILL.md`.

## What not to read

Do not read, mount or pass values from these paths, unless the user named one and asked for it:

- `.env` and `.env.*`, in the repo or in the home directory.
- `~/.ssh/`, `~/.aws/`, `~/.gcloud/`, `~/.kube/` and `~/.docker/config.json`.
- Browser profiles, password manager data and keychain entries.
- Shell rc files such as `~/.zshrc`, because they often export API keys.
- Any file with `key`, `token`, `secret` or `credential` in its name.

`secrets-and-sensitive-data.md` tells you what to do when a workflow needs one of them.
