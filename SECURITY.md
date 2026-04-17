# Security policy

## Reporting a vulnerability

Open a [GitHub issue](https://github.com/alfredvc/claude-airlock/issues). Include:

- Affected version (`ccairlock --version`)
- Host OS
- Reproduction steps or PoC
- Expected vs. actual behavior

## Threat model

Full design: [`docs/SPEC.md`](docs/SPEC.md). Summary below.

### In scope — not accepted

Any write to the host filesystem outside the paths enumerated in [`docs/SPEC.md` §"Host writable paths"](docs/SPEC.md). Specifically, the container must **not** be able to mutate:

- Real git repositories passed via `--repo` / `--extra-repo` (only `sandbox/<ts>` ref creation via host-side `git fetch` on exit is permitted).
- Host `~/.claude/`, `~/.claude.json`, plugin marketplace repos.
- Any `--ro` reference path.
- Any host path not explicitly opted-in via `--mount`.

A bug that lets the container escape those constraints is a vulnerability. Report it.

### Out of scope — accepted risk

- **Exfiltration.** Anything the container can read (host `~/.claude/` contents, RO-mounted repos, reference paths, secrets in env) may be sent over the network. The container has unrestricted outbound HTTPS. If your threat model requires network egress control, do not run this tool.
- **Container escape.** Not addressed by this project. We follow Docker defaults (no `--privileged`, no `SYS_ADMIN`, no `docker.sock` mount, `--cap-drop=ALL`, non-root user) but do not harden further. A kernel or Docker runtime exploit is out of scope — take it up with Docker / the kernel.
- **`--mount <path>` writes.** User-declared live RW bind mounts bypass the host-write invariant for exactly the path given. Using `--mount` is opt-in; any host mutation via that path is expected behavior.
- **`--dangerously-skip-permissions` semantics inside the container.** Claude Code runs with all permissions by design. Inside-container destruction of the session clone, session scratch, `/output`, and declared `--mount` targets is expected.

### Hardening posture

- `docker run --cap-drop=ALL --user <hostuid>:<hostgid> --rm`
- No `--privileged`, no `SYS_ADMIN`, no `docker.sock` mount
- Host repos RO-mounted; container-written copies live in a session clone
- Credentials surface via a single RO bind (`/host-claude-creds`); `~/.claude/.credentials.json` is excluded from the general `/host-claude` mount
- macOS credentials materialized from Keychain to session scratch at mode `0600`, deleted with the session on exit

## Supported versions

Pre-1.0. Only the latest minor receives security fixes. After 1.0, the latest two minors will be supported.

| Version | Supported |
|---------|-----------|
| 0.1.x   | Yes       |
| < 0.1   | No        |

## Scope of this policy

Covers the `claude-airlock` CLI, its shipped `docker/Dockerfile`, and `docker/entrypoint.sh`. Bugs in upstream Claude Code, Docker, Node, or the host kernel are not covered here — report those upstream.
