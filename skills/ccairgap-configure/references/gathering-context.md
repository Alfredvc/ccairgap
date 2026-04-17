# Gathering context (Phase 1)

Before recommending config, probe the host. Don't ask the user questions you can answer yourself with a tool call. Don't probe for secrets (see "What NOT to probe for" at the bottom).

## Minimum probe

Run these in parallel when you can.

### Git repo shape

```bash
git rev-parse --show-toplevel          # workspace repo root
git config --get user.name             # identity passthrough sanity check
git config --get user.email
git status --porcelain                 # is there in-progress work?
```

Read `<repo>/.gitmodules` if present. Submodules are a known limitation — warn the user they won't initialize inside the container from private remotes.

### Project type

Look for manifests at the repo root:

| File | Language / toolchain | Gitignored build/cache dirs to probe |
|------|----------------------|---------------------------------------|
| `package.json` | Node | `node_modules`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`, `.parcel-cache`, `dist`, `build`, `out`, `.cache` |
| `bun.lockb` | Bun | same as Node |
| `deno.json` | Deno | `.deno`, `node_modules` |
| `pyproject.toml`, `requirements.txt`, `Pipfile`, `setup.py` | Python | `.venv`, `venv`, `.mypy_cache`, `.pytest_cache`, `.ruff_cache`, `.tox` |
| `Cargo.toml` | Rust | `target` |
| `go.mod` | Go | `vendor` (only if gitignored) |
| `Gemfile` | Ruby | `vendor/bundle` |
| `pom.xml`, `build.gradle`, `build.gradle.kts` | JVM | `target`, `build`, `.gradle` |
| `*.xcodeproj`, `Podfile` | iOS / Xcode | `Pods`, `DerivedData` |

Read the manifest if present — `scripts` / `dependencies` / `devDependencies` hint at tools the workflow shells out to (Playwright, Puppeteer, Prisma, Cypress, etc.). These drive Dockerfile decisions.

### Gitignored-dir probe (drives the default `ro:` list)

The workspace repo is cloned from git into session scratch — gitignored dirs (`node_modules`, `target`, `.venv`, etc.) are **not in the clone**. Without a mount, the container sees an empty path where deps should be; imports don't resolve, LSP doesn't work. The default fix is `ro:` (read-only access to the host cache).

For each dir from the project-type table, verify both:

```bash
# Existence on host
test -d <repo>/<dir>

# Gitignored in this repo
git -C <repo> check-ignore <dir>        # exit 0 = ignored
```

Example probe (adapt paths):

```bash
for d in node_modules .next dist .turbo; do
  if [ -d "$REPO/$d" ] && git -C "$REPO" check-ignore "$d" >/dev/null 2>&1; then
    echo "ro: $d"
  fi
done
```

Every dir that passes both checks goes into `ro:` by default. Include it in Phase 2 proposal so the user can confirm or override.

Skip:
- Tiny per-file caches (`__pycache__/`, `.DS_Store` etc.) — regeneration is trivial.
- Non-gitignored dirs that happen to share a name (some monorepos commit a skeleton `dist/`).
- Dirs outside the workspace repo (those are reference / sibling material — ask the user).

### Claude setup

```bash
ls -la ~/.claude/
cat ~/.claude/settings.json       # if it exists
cat ~/.claude.json                # mcpServers block
```

Also check project-scoped settings:

```bash
cat <repo>/.claude/settings.json
cat <repo>/.claude/settings.local.json
```

Extract:

- **Hooks** — every entry in `hooks.*` arrays has a `command` string. Record them; these will be filtered by `--hook-enable` globs. A hook referencing a host-only path (`~/scripts/...`, `/opt/homebrew/bin/...`) is a tell the user will need to either enable + install the binary in a custom Dockerfile, or leave the hook disabled.

  **Use `ccairgap hooks` instead of hand-walking sources.** It enumerates every entry ccairgap would see at launch across all three sources (user settings, each enabled plugin's `hooks.json`, project `.claude/settings.json[.local]` for `--repo` + every `--extra-repo`) as JSON — one object per entry with `source`, `sourcePath`, `event`, `matcher`, `command`. Pass `--repo` / `--extra-repo` that match the launch you're configuring, or run inside the target repo and defaults match. This is the canonical way; walking files with `jq` misses plugin hooks.
- **MCP servers** — `mcpServers` entries in `~/.claude.json` (and project `.claude.json` if present). Each has a `command` (binary) and optional `args`. If the command isn't in the base image's PATH, it needs either a Dockerfile extension or it won't work inside the container.
- **Plugin marketplaces** — `extraKnownMarketplaces` entries with `source.source: "directory"` or `"file"` are host paths that ccairgap auto-discovers and RO-mounts. User doesn't have to configure these.
- **Status line** — `statusLine.command` is a hook-like entry; filtered the same way.

### Binary dependencies inside the container

Base image provides: `node`, `npm`, `git`, `git-lfs`, `curl`, `jq`, `rsync`, `ca-certificates`, `less`, `vim`, `@anthropic-ai/claude-code`.

Anything else the workflow needs — `python3`, `pip`, `uv`, `cargo`, `go`, `playwright`, cloud SDKs, language-specific package managers — needs a custom Dockerfile entry. Build the list by looking at:

- MCP `command` fields (often `uv`, `npx`, `python3`).
- Hook `command` fields (same).
- `package.json` `scripts` (hint at what the workflow invokes).
- `.tool-versions` / `.nvmrc` / `.python-version` (version pins the user likely wants).
- CI config (`.github/workflows/*.yml`) — whatever CI does, the container often needs too.

This is the primary input to the Dockerfile. The secondary input (reference dirs) feeds the `ro:` list.

### Reference directories Claude will read

Sibling repos, docs trees, shared-type packages, reference datasets. Two ways to expose them, both host-safe:

- `extra-repo: [<path>]` — another git repo the user is actively editing. Gets a sandbox branch like `--repo` does.
- `ro: [<path>]` — anything else (docs, types-only mirror, reference data). Read-only bind mount.

Scan the project for signs Claude will want these:

- `tsconfig.json` `paths` / `references` pointing outside the repo.
- `Cargo.toml` `path = "..."` dependencies.
- `go.mod` `replace` directives to local paths.
- `.python-version` / `pyproject.toml` `[tool.<x>.sources]` referring to sibling packages.
- `README.md` / `CONTRIBUTING.md` mentions of companion repos.

When in doubt, ask the user: "Does Claude need access to any of these sibling directories during the session?" — list them and let the user pick.

## What NOT to probe for

The following are **out of scope** for the default probe. Don't read them, don't propose mounting them, don't propose passing env values from them, unless the user has explicitly asked and named what they need:

- `.env`, `.env.*` files in the repo or home dir.
- `~/.ssh/` (keys), `~/.aws/`, `~/.gcloud/`, `~/.kube/`, `~/.docker/config.json`.
- Browser profiles (`~/.config/google-chrome/`, `~/Library/Application Support/...`).
- Password manager data, keychain entries.
- Shell rc files (`~/.zshrc`, `~/.bashrc`) — they often contain exported API keys.
- Any file matching `*key*`, `*token*`, `*secret*`, `*credential*` unless the user named it.

If the user's workflow does need a credential, read `references/secrets-and-sensitive-data.md` and wire it up explicitly (with the user's confirmation, via `-e NAME` pass-through — never by committing values to config).

## Align before producing

After probing, state what you found and your proposed config. Be explicit about what you decided *not* to add. Let the user redirect before you write anything.

Good framing:

> Found: Node/TypeScript project at `~/src/foo`. Gitignored dirs present: `node_modules` (1.2 GB), `.next`, `dist`. Your `~/.claude/settings.json` has two hooks (one `python3` auto-approve, one `bash` statusline). MCP servers: `grafana` (uses `docker` — won't work in sandbox without Dockerfile extension *and* a socket mount that defeats the sandbox; don't enable), `puppeteer-mcp` (uses `npx`, should work).
>
> Proposed:
> - `config.yaml`: `ro:` mount `node_modules`, `.next`, `dist` so Claude can read them (they're gitignored → missing from the session clone without this). Enable two hooks: `python3 *`, `bash ~/.claude/statusline.sh`.
> - Custom `Dockerfile`: base + Python 3 (for the auto-approve hook).
>
> Not adding (tell me if you want any of these):
> - Write access to the above dirs. `npm install` / `npm run build` will fail inside the sandbox; escalate to `--cp` (session-local copy) or `--mount` (host writes) per dir if needed.
> - Any port publish, env var passthrough, or network attach.
> - Grafana MCP (needs host docker daemon → breaks sandbox).
>
> Confirm or tell me what to change.

Being specific about what you didn't add is the difference between a useful config and a leaky one.
