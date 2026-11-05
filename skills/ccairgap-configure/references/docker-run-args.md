# Raw docker run args

`--docker-run-arg` is the escape hatch for `docker run` flags ccairgap does not expose as dedicated CLI flags. Most users never need one — the structured flags (`--ro`, `--mount`, `--cp`, `--sync`, `--dockerfile`) cover the common cases.

Reach for this when you need to:

- Expose a port to the host (`-p`).
- Attach to a user-created docker network (`--network`).
- Pass an env var through (`-e NAME`).
- Bump memory / CPU limits (`--memory`, `--cpus`).
- Use a mount option the structured flags don't surface (`:rw,cached` etc.).

## Parsing rules

- Each `--docker-run-arg <value>` is shell-split: `"-p 8080:8080"` → `["-p", "8080:8080"]`.
- Quoting works like a shell: `'--label "key=val with space"'` → `--label` + `key=val with space`.
- Shell operators / subshells / globs are rejected at launch (`&&`, `|`, `$(...)`, `*.log`). Tokens must be literal.
- Repeatable on CLI; config file key `docker-run-arg: [<string>, …]`. Config values come first, CLI appended.

## Ordering + last-wins

Built-in `docker run` looks like:

```
docker run --rm -it --cap-drop=ALL --name ccairgap-<id> \
  -e CCAIRGAP_CWD=... -e CCAIRGAP_TRUSTED_CWDS=... [-e CCAIRGAP_PRINT=...] \
  -v <host-claude>:/host-claude:ro  ...  [all the other built-in mounts] \
  <your --docker-run-arg tokens here>  \
  ccairgap:<tag>
```

Because your tokens land last, you can override:
- `--network my-net` overrides the default bridge.
- `--name <custom>` overrides `ccairgap-<id>` — almost always a bad idea; breaks `ccairgap list` and orphan detection.
- `--cap-drop NET_RAW` narrows the initial `--cap-drop=ALL`.
- Additional `-e FOO=bar` values stack with built-in envs, last-wins per key.
- Additional `-v` / `--mount` values can also shadow built-in mounts, including reserved paths such as `/home/claude/.codex` or `/output`.

Reserved-path checks apply to structured ccairgap inputs (`--repo`, `--ro`, `--mount`, `--cp`, `--sync`, discovered marketplaces). Raw docker args are appended after those checks and are treated as an explicit escape hatch outside the reserved-path guarantee.

## Recipes

### Publish a port

```yaml
docker-run-arg:
  - "-p 5173:5173"
```

For `localhost`-only binding: `"-p 127.0.0.1:5173:5173"`.

### Attach to a user-created docker network

> With a [network policy](network.md) active, the CLI rejects flags that can bypass the proxy, including `--network`, `-p`, `--privileged` and `--cap-add`.

```yaml
docker-run-arg:
  - "--network dev-net"
```

Inside the container, `db` / named containers resolve via Docker's embedded DNS.

### Reach host services (`localhost` on the host)

Linux needs `--add-host` with the `host-gateway` sentinel; macOS/Windows Docker Desktop already resolves `host.docker.internal`:

```yaml
docker-run-arg:
  - "--add-host=host.docker.internal:host-gateway"
```

Container code then connects to `host.docker.internal:<port>`.

This does not work with a network policy active. `--add-host` is accepted, but the agent has no route, and the proxy refuses private addresses.

### Extra environment variables

If any of these is a credential, read [secrets-and-sensitive-data.md](secrets-and-sensitive-data.md) first.

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

**Never put a literal secret value into a committed `config.yaml`.** Pass-through (`-e NAME` without `=value`) is the safe pattern.

### Resource limits

```yaml
docker-run-arg:
  - "--memory=8g"
  - "--cpus=4"
```

### Named volumes (persistent docker-managed storage)

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

Danger tokens aren't recommended. They remove the isolation ccairgap provides — if you need `--privileged` or `docker.sock`, the honest answer is "use the host Claude directly; this workload can't sandbox."

## Secrets and sensitive data

Read [secrets-and-sensitive-data.md](secrets-and-sensitive-data.md) before you pass a credential.

## When to reach for this vs. other surfaces

| Need | Right surface |
|------|---------------|
| Expose a port | `docker-run-arg` |
| Attach to docker network | `docker-run-arg` |
| Pass a non-secret env var | `docker-run-arg` |
| Pass a secret env var | `docker-run-arg -e NAME` pass-through |
| Mount a host dir RW | `mount` (structured), or `docker-run-arg -v` if you need extra mount options |
| Install a binary | custom `Dockerfile`, not `docker-run-arg` |
| Persist a language cache | `mount <dir>` (host-backed) or `docker-run-arg -v cache:<path>` (named volume) |
| Increase memory / CPU | `docker-run-arg` |
