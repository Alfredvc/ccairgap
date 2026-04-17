# `--docker-run-arg` cookbook (only-when-user-asks)

`--docker-run-arg` is the escape hatch for `docker run` flags ccairgap does not expose as dedicated CLI flags. The skill's default stance: **do not propose `--docker-run-arg` entries.** Most users never need one, and a config file full of speculative ports / env vars is leakier than one without.

Only reach for this reference when the user has explicitly described a need that maps to a `docker run` flag. Concrete triggers:

- User says "expose port X" / "I want to hit the dev server from my browser" → port publish.
- User says "attach to my docker network `foo`" / "talk to my local Postgres container" → `--network` or `--add-host`.
- User says "the MCP needs `$OPENAI_API_KEY`" / names a specific env var → env pass-through (also read `secrets-and-sensitive-data.md`).
- User says "this build is OOMing" / "it needs more RAM" → resource limits.

If none of those applies, close this file and don't add a `docker-run-arg` entry.

## Parsing rules

- Each `--docker-run-arg <value>` is shell-split: `"-p 8080:8080"` → `["-p", "8080:8080"]`.
- Quoting works like a shell: `'--label "key=val with space"'` → `--label` + `key=val with space`.
- Shell operators / subshells / globs are rejected at launch (`&&`, `|`, `$(...)`, `*.log`). Tokens must be literal.
- Repeatable on CLI; config file key `docker-run-arg: [<string>, …]`. Config values come first, CLI appended.

## Ordering + last-wins

Built-in `docker run` looks like:

```
docker run --rm -it --cap-drop=ALL --name claude-airgap-<ts> \
  -e AIRGAP_CWD=... -e AIRGAP_TRUSTED_CWDS=... [-e AIRGAP_PRINT=...] \
  -v <host-claude>:/host-claude:ro  ...  [all the other built-in mounts] \
  <your --docker-run-arg tokens here>  \
  claude-airgap:<tag>
```

Because your tokens land last, you can override:
- `--network my-net` overrides the default bridge.
- `--name <custom>` overrides `claude-airgap-<ts>` — almost always a bad idea; breaks `ccairgap list` and orphan detection.
- `--cap-drop NET_RAW` narrows the initial `--cap-drop=ALL`.
- Additional `-e FOO=bar` values stack with built-in envs, last-wins per key.

## Recipes (use only when the user has asked for the specific thing)

### Publish a port

User said: "I want to view the dev server from my host browser."

```yaml
docker-run-arg:
  - "-p 5173:5173"
```

For `localhost`-only binding: `"-p 127.0.0.1:5173:5173"`.

### Attach to a user-created docker network

User said: "I have Postgres running in docker on network `dev-net`, the container needs to reach it."

```yaml
docker-run-arg:
  - "--network dev-net"
```

Inside the container, `db` / named containers resolve via Docker's embedded DNS.

### Reach host services (`localhost` on the host)

User said: "The container needs to hit a service running on my host machine."

Linux needs `--add-host` with the `host-gateway` sentinel; macOS/Windows Docker Desktop already resolves `host.docker.internal`:

```yaml
docker-run-arg:
  - "--add-host=host.docker.internal:host-gateway"
```

Container code then connects to `host.docker.internal:<port>`.

### Extra environment variables

**Read `references/secrets-and-sensitive-data.md` first if any of these look like credentials.**

Inherit a host env var (value stays on the host at launch time, passed through):

```yaml
docker-run-arg:
  - "-e OPENAI_API_KEY"          # pass-through — no value in the config file
```

Literal non-secret value:

```yaml
docker-run-arg:
  - "-e LOG_LEVEL=debug"
```

From a CLI shell (values expand on the host at launch):

```bash
ccairgap --docker-run-arg "-e MY_API_KEY=$MY_API_KEY"
```

**Never put a literal secret value into a committed `config.yaml`.** Pass-through (`-e NAME` without `=value`) is the safe pattern. If the user hasn't told you they need a specific env var, don't add one.

### Resource limits

User said: "Builds are getting OOM-killed / too slow."

```yaml
docker-run-arg:
  - "--memory=8g"
  - "--cpus=4"
```

### Named volumes (persistent docker-managed storage)

User said: "I want a persistent cache that doesn't touch my host FS."

```yaml
docker-run-arg:
  - "-v cargo-cache:/home/claude/.cargo"
```

Docker creates the `cargo-cache` named volume on first use. Survives across sessions. Does not touch host FS directly. Often a middle ground between "regenerate every time" and "live-mount a host dir".

### Extra host bind mount — prefer `--mount` first

For a host-backed RW mount, the first choice is `mount: [<path>]` in structured config — it's narrower and stays inside the known writable-paths set. Use raw `-v` only when you need mount options the CLI doesn't pass:

```yaml
docker-run-arg:
  - "-v /var/cache/npm:/var/cache/npm:rw,cached"   # macOS perf tweak
```

## Danger tokens — what the CLI warns about

The CLI scans your tokens and prints one stderr line per hit. These do **not** block launch. The scan catches:

| Token | Why it's dangerous |
|-------|--------------------|
| `--privileged` | Grants all capabilities + device access. Effectively removes the sandbox. |
| `--cap-add`, `--cap-add=...` | Adds Linux capabilities back. Typical target: `SYS_ADMIN`. |
| `--security-opt ...` | Overrides apparmor/seccomp/etc. |
| `--device ...` | Exposes a host device. |
| `--network host`, `--network=host`, `--net host`, `--net=host` | Container shares host network namespace. |
| `--pid host`, `--pid=host` | Container sees host PIDs, can signal host processes. |
| `--userns host`, `--ipc host`, `--uts host` (and `=host` forms) | Share other host namespaces. |
| Anything containing `docker.sock` | Grants control over host Docker daemon → full root on host. |
| Anything containing `SYS_ADMIN` | Kernel admin capability. |
| `--cap-drop <X>` or `--cap-drop=<X>` where `X != ALL` | Narrows the default `--cap-drop=ALL`. |

Suppress with `--no-warn-docker-args` (CLI) or `warn-docker-args: false` (config). Suppression silences the warning, it doesn't make the flags safe.

The scan is best-effort: equivalent effects can be reached via flags the scanner doesn't know about. Don't treat absence of warning as a safety certificate.

**Do not recommend any of these danger tokens.** If a user asks for one, respond with what they'd actually get: "that disables the sandbox — is that what you want?" and wait.

## When to reach for this vs. other surfaces

| User need (stated by user) | Right surface |
|-----------|---------------|
| Expose a port | `docker-run-arg` |
| Attach to docker network | `docker-run-arg` |
| Pass a non-secret env var | `docker-run-arg` |
| Pass a secret env var | `docker-run-arg -e NAME` pass-through + `secrets-and-sensitive-data.md` |
| Mount a host dir RW | `mount` (structured), or `docker-run-arg -v` if you need extra mount options |
| Install a binary | custom `Dockerfile`, not `docker-run-arg` |
| Persist a language cache | `mount <dir>` (host-backed) or `docker-run-arg -v cache:<path>` (named volume) |
| Increase memory / CPU | `docker-run-arg` |

If you find yourself recommending `--privileged`, `--cap-add`, `--pid=host`, `--network=host`, or `docker.sock`: stop. Those defeat the entire purpose of ccairgap. Either use the host Claude (no sandbox, user's choice) or find a different approach.
