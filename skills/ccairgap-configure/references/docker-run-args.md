# `--docker-run-arg` cookbook

`--docker-run-arg` is the escape hatch for any `docker run` flag that ccairgap doesn't expose as a dedicated CLI flag. Parsed with `shell-quote`, appended after all built-ins, resolved by Docker last-wins semantics.

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
- `--name <custom>` overrides `claude-airgap-<ts>` (mostly a bad idea — breaks `ccairgap list` / orphan detection).
- `--cap-drop NET_RAW` narrows the initial `--cap-drop=ALL`.
- Additional `-e FOO=bar` values stack with built-in envs, last-wins per key.

## Recipes

### Publish a port

```yaml
docker-run-arg:
  - "-p 5173:5173"
```

Same as `docker run -p`. Host:container mapping. For `localhost`-only binding: `"-p 127.0.0.1:5173:5173"`.

### Attach to a user-created docker network

If the user has a running Postgres / Redis / whatever on a named network:

```bash
docker network create dev-net
docker run -d --network dev-net --name db postgres:15
```

Then ccairgap:

```yaml
docker-run-arg:
  - "--network dev-net"
```

Inside the container, `db` resolves via Docker's embedded DNS.

### Reach host services (`localhost` on the host)

Linux needs `--add-host` with the `host-gateway` sentinel; macOS/Windows Docker Desktop already resolves `host.docker.internal`:

```yaml
docker-run-arg:
  - "--add-host=host.docker.internal:host-gateway"
```

Container code then connects to `host.docker.internal:<port>`.

### Extra environment variables

Inherit a host env var:

```yaml
docker-run-arg:
  - "-e OPENAI_API_KEY"          # pass-through (container sees same value as host)
```

Literal value:

```yaml
docker-run-arg:
  - "-e LOG_LEVEL=debug"
```

From a CLI shell (values expand on the host at launch time):

```bash
ccairgap --docker-run-arg "-e MY_API_KEY=$MY_API_KEY"
```

Don't put secrets into a committed `config.yaml`. Pass-through (`-e NAME` without `=value`) is the safe pattern.

### Extra volume / bind mount

Prefer `--mount <path>` in structured config — it's narrower and stays inside the known writable-paths set. Use raw `-v` only when you need options the CLI doesn't pass:

```yaml
docker-run-arg:
  - "-v /var/cache/npm:/var/cache/npm:rw,cached"   # macOS perf tweak
```

### Resource limits

```yaml
docker-run-arg:
  - "--memory=8g"
  - "--cpus=4"
```

Useful for CI runs or big builds.

### Named volumes (persistent docker-managed storage)

```yaml
docker-run-arg:
  - "-v cargo-cache:/home/claude/.cargo"
```

Docker will create the `cargo-cache` named volume on first use. Survives across sessions. Does not touch host FS directly.

## Danger tokens — what the CLI warns about

The CLI scans your tokens and prints one stderr line per hit. These do not block launch. The scan catches:

| Token | Why it's dangerous |
|-------|--------------------|
| `--privileged` | Grants all capabilities + device access. Effectively removes the sandbox. |
| `--cap-add`, `--cap-add=...` | Adds Linux capabilities back. Typical target: `SYS_ADMIN` (kernel admin ops). |
| `--security-opt ...` | Overrides apparmor/seccomp/etc. |
| `--device ...` | Exposes a host device. |
| `--network host`, `--network=host`, `--net host`, `--net=host` | Container shares host network namespace. |
| `--pid host`, `--pid=host` | Container sees host PIDs, can signal host processes. |
| `--userns host`, `--ipc host`, `--uts host` (and `=host` forms) | Share other host namespaces. |
| Anything containing `docker.sock` | Grants control over the host Docker daemon → full root on host. |
| Anything containing `SYS_ADMIN` | Kernel admin capability. |
| `--cap-drop <X>` or `--cap-drop=<X>` where `X != ALL` | Narrows the default `--cap-drop=ALL`. |

Suppress with `--no-warn-docker-args` (CLI) or `warn-docker-args: false` (config). **Suppression silences the warning, it doesn't make the flags safe.**

The scan is best-effort: a user can achieve equivalent effects with flags the scanner doesn't know about. Don't treat absence of warning as a safety certificate.

## When to reach for this vs. other surfaces

| User need | Right surface |
|-----------|---------------|
| Expose a port | `docker-run-arg` |
| Attach to docker network | `docker-run-arg` |
| Pass an env var | `docker-run-arg` |
| Mount a host dir RW | `--mount` (structured), or `docker-run-arg -v` if you need extra mount options |
| Install a binary | custom `Dockerfile`, not `docker-run-arg` |
| Persist a language cache | `--mount <dir>` (host-backed) or `docker-run-arg -v cache:<path>` (named volume) |
| Increase memory / CPU | `docker-run-arg` |

If you find yourself recommending `--privileged`, `--cap-add`, `--pid=host`, or `docker.sock` to make something work: stop. Those defeat the entire purpose of ccairgap. Either use the host Claude (no sandbox, user's choice) or find a different approach.
