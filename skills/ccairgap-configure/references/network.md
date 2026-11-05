# Network policy

The `network` config key limits the outbound traffic of a session to the hosts, ports, methods and paths that you allow. Without the key, a session has full outbound access.

```yaml
# .ccairgap/config.yaml, or .ccairgap/<profile>.config.yaml
network:
  rules:
    - host: github.com
      methods: [GET]
      paths: ["/acme/*"]
    - host: registry.npmjs.org
      methods: [GET]
```

This config allows the agent's own API, read access to one GitHub organization and read access to npm. Every other request gets `403`. The CLI prints the active rules to stderr at launch.

## How enforcement works

The agent container runs with `--network none`, so its only interface is loopback. Its only route out is a Unix socket to a separate container, the sidecar, which runs [mitmproxy](https://mitmproxy.org) and holds the policy. The agent has no capabilities, so it cannot change its own network. It cannot edit the policy, because the policy files are not mounted in its container.

The proxy decrypts HTTPS with a certificate authority (CA) that it generates for each session. The CA private key stays in the sidecar. The CLI sets the standard env vars, and the entrypoint adds the CA certificate to the bundle that they name, so clients trust it. See [`SPEC.md`](https://github.com/alfredvc/ccairgap/blob/main/docs/SPEC.md) §"Network policy" for the full design.

## Where the policy lives

- Project config and profiles can set the key. Use a profile to keep several policies for one repository, for example `--profile locked-down`.
- `~/.config/ccairgap/config.yaml` and integration drop-ins cannot set the key. The CLI exits with an error if they do.
- ccairgap finds project config in the git repository that contains the current directory, and `--repo` does not change this. `ccairgap --repo /path/to/repo` from another directory does not load that repository's policy.
- `--bare` skips project config unless you also pass `--config` or `--profile`. Without those flags, a `--bare` session has no policy.

Check the launch output. No "network policy active" line means that the session has full outbound access.

## Rule reference

| Key | Default | Meaning |
|---|---|---|
| `action` | `allow` | `allow` or `deny`. |
| `host` | required | An exact name, or `*.example.com`. The wildcard form matches subdomains at any depth and does not match `example.com`. A bare `*` and a wildcard over a top-level domain, such as `*.com`, are errors. |
| `ports` | `[443]` on `allow`, every port on `deny` | Ports that the rule covers. Add `80` for plain HTTP. |
| `methods` | all | HTTP methods that the rule covers. |
| `paths` | all | Path patterns. Each starts with `/`, and `*` matches any characters, including `/`. The query string is not matched. |

The first rule that matches decides. A request that matches no rule gets `403`. Your rules run before the agent preset, so a deny rule can narrow a preset host.

| Option | Default | Meaning |
|---|---|---|
| `agent-preset` | `true` | Adds the rules that the selected agent needs. |
| `check-credentials` | `true` | See "Credential check". |

`network: {}` allows the agent preset only. `agent-preset: false` with no rules denies every request, so the agent cannot start a conversation.

## Examples

Each example is a complete `network` block. Add it to `.ccairgap/config.yaml`, or to a profile.

**Allow the agent's own API and nothing else.**

```yaml
network: {}
```

**Install npm packages, with no other route.** `npm install` reads with `GET`, so a registry rule needs no other method.

```yaml
network:
  rules:
    - host: registry.npmjs.org
      methods: [GET]
```

**Fetch from one GitHub organization and block every push.** `git fetch` and `git clone` send `POST` to `git-upload-pack`, so `GET` alone is not enough. The deny rule comes first because the first matching rule decides.

```yaml
network:
  rules:
    - action: deny
      host: github.com
      paths: ["/*/git-receive-pack"]
    - host: github.com
      methods: [GET, POST]
      paths: ["/acme/*"]
```

**Narrow a preset host.** Your rules run before the preset, so a deny rule removes part of what the preset allows. This rule removes `/v1/mcp_servers` from the Claude preset. A Claude Code print session completed with this rule, and its exit summary listed the denied requests.

```yaml
network:
  rules:
    - action: deny
      host: api.anthropic.com
      paths: ["/v1/mcp_servers"]
```

**Allow plain HTTP.** An `allow` rule covers only port 443 unless you set `ports`, so list both ports to allow both schemes.

```yaml
network:
  rules:
    - host: deb.example.com
      methods: [GET]
      ports: [80, 443]
```

**Allow subdomains, with one exception.** `*.example.com` matches `a.example.com` and `a.b.example.com`. It does not match `example.com`, so the apex needs its own rule. Quote a wildcard host, because YAML reads an unquoted leading `*` as an alias and the CLI then exits with a parse error.

```yaml
network:
  rules:
    - action: deny
      host: uploads.example.com
    - host: "*.example.com"
      methods: [GET]
    - host: example.com
      methods: [GET]
```

**Keep a stricter profile next to the default config.** Each profile file replaces the project config for that session, so a session with no `--profile` uses `config.yaml`.

```yaml
# .ccairgap/locked-down.config.yaml
network: {}
```

```bash
ccairgap --profile locked-down
```

## Common hosts

These hosts cover the usual package and git traffic. `methods: [GET]` is enough for each row except git.

| Tool | Hosts |
|---|---|
| npm, pnpm, yarn | `registry.npmjs.org` |
| pip, uv | `pypi.org`, `files.pythonhosted.org` |
| cargo | `index.crates.io`, `static.crates.io` |
| Go modules | `proxy.golang.org`, `sum.golang.org` |
| git over HTTPS | `github.com`, with `POST` for `git-upload-pack` |

A registry can redirect to a host that is not in this table. The exit summary lists each denied host, so add a rule for the hosts that you trust and start a new session.

## Agent presets

| Agent and auth | Host | Methods | Paths |
|---|---|---|---|
| Claude | `api.anthropic.com` | `GET`, `POST` | `/v1/messages`, `/v1/messages/count_tokens`, `/v1/mcp_servers`, `/api/web/domain_info` |
| Codex with ChatGPT auth | `chatgpt.com` | `GET` | `/backend-api/codex/responses`, `/backend-api/codex/models`, `/backend-api/wham/accounts/check` |
| Codex with an API key | `api.openai.com` | `GET`, `POST` | `/v1/responses` |

Real Claude and Codex ChatGPT sessions passed with these presets, in the TUI and in print mode. The Codex API-key preset has no successful real session. A newer agent version can need other paths. The exit summary shows what the proxy denied.

The presets deny optional agent traffic, so the exit summary lists denials in a normal session. Claude Code retries `mcp-proxy.anthropic.com`, which claude.ai MCP connectors use. Codex calls plugin, analytics and usage endpoints on `chatgpt.com`, and print mode logs an MCP error for them. Both agents still complete their work. Add a rule if you need one of these features.

## Credential check

The check stops an agent from sending your data to another account through an allowed provider API. For `api.anthropic.com`, `chatgpt.com` and `api.openai.com`, the proxy accepts only tokens that the CLI itself gave to the session. It compares SHA-256 hashes, and it removes `Cookie` headers on these hosts.

Set `check-credentials: false` in these cases:

- You pass a key through `--docker-run-arg`, for example `-e ANTHROPIC_API_KEY`.
- The session calls another provider on purpose, for example a Claude session that calls `api.openai.com` with its own key.

In-container `/login` does not work while the check is on, because the new token has no hash. For Claude, log in on the host. The runtime auth refresh then delivers the new token within 60 seconds, unless an in-container `/login` already wrote a token. In that case, start a new session. Codex has no runtime refresh, so start a new session when a Codex token expires.

## What the policy does not stop

The policy does not inspect request bodies or WebSocket frames.

- **Data in allowed requests.** An agent can put any data it can read into a request to an allowed host. This includes the prompt that it sends to its own provider.
- **Server-side fetches.** The Messages API documents `mcp_servers` and URL image and document sources. These features can cause the provider to contact a third party with data from the request. `GET /api/web/domain_info` in the Claude preset takes a domain name in its query, and it may cause a provider lookup of that name. The proxy sees only the request to the provider.
- **Allowed hosts with write access.** If you allow `POST` to `github.com`, an agent with a token can write to any account that the token reaches, and a token for another account also works. Keep write access narrow with `methods` and `paths`.
- **DNS under a wildcard.** The proxy resolves any host that a rule allows. Under `*.example.com`, an agent can place data in a subdomain, and the DNS servers for `example.com` can see it. A denied name causes no lookup.
- **Path variants under deny rules.** A deny rule also matches case differences, `%2F`, `;` parameters and trailing slashes. A server with other routing rules can still receive a variant that your deny rule does not match. Prefer allow rules.
- **Query strings.** Rules do not match the query, so data in a query passes any rule that allows the path.
- **Mounted sockets.** A Unix socket reachable through a mount is a route that the proxy does not see. The CLI rejects a mount that contains a known Docker socket. It cannot find other sockets.
- **Container and kernel escapes.** These stay out of scope. See [`SECURITY.md`](https://github.com/alfredvc/ccairgap/blob/main/SECURITY.md).

## What fails under a policy

- `ssh` and other non-HTTP protocols. Use HTTPS git remotes.
- Clients that pin certificates, or that ignore the proxy or CA env vars.
- Private addresses, including `localhost` on the host, `host.docker.internal` and other containers. A rule cannot allow them.
- Upstream TLS interception. The sidecar trusts public CAs only, so a host `NODE_EXTRA_CA_CERTS` is not forwarded.
- A client that half-closes its side before the response gets no response, because mitmproxy closes the connection.
- A `GET` or `HEAD` with a body gets `403`.
- A denied request with a body over 1 MiB, or with chunked encoding, sees the connection close with no `403`.

Image builds are not affected. They run on the host before the session starts.

## Conflicting docker args

The CLI exits with an error when a `--docker-run-arg` token can bypass the proxy: `--network`, `--net`, `--link`, `-p`, `--publish`, `--privileged`, `--cap-add`, host namespace flags, `--device`, `--security-opt`, `--volumes-from`, and any mount that exposes a Docker socket. A raw mount or `--mount` of a path that contains the ccairgap state directory is also an error, because the agent could then edit the policy. `--ro ~` passes unless your home holds a known Docker socket. [`SPEC.md`](https://github.com/alfredvc/ccairgap/blob/main/docs/SPEC.md) §"Conflicting docker args" has the full list. The scan covers known flags only. `--add-host` and `--dns` stay allowed because they open no route.

## Troubleshooting

- **A request fails with `403`.** Read the summary that the CLI prints at exit. Each line gives the count, the request and the reason.
- **A request to an allowed host fails with `502`.** The host resolves to a non-public address, or the name does not resolve. The sidecar log shows the reason.
- **Read decisions during a session.** Run `docker logs -f ccairgap-<id>-network`. Each decision logs the stage, verdict, reason, method, host, port and path. The addon does not log header values, query strings or bodies.
- **The sidecar stops.** The CLI prints a warning, and the agent loses all network access. It gets no direct route. The sidecar has a 1 GiB memory limit.
- **The CLI receives a signal.** The CLI stops the agent, prints the denial summary, removes the sidecar and runs handoff. A second signal removes the sidecar and exits at once, without the summary. The session then stays on disk: run `ccairgap recover <id>` or `ccairgap discard <id>`.
- **The CLI gets a SIGKILL.** Run `docker rm -f ccairgap-<id>`, then `ccairgap recover <id>` or `ccairgap discard <id>`. These commands remove the sidecar and its volume. If the agent container still holds the volume, they print the command that removes both.
- **`--keep-container`.** The kept agent container holds the socket volume. The CLI prints the command that removes both.

## Tested platforms

Real agent sessions ran on OrbStack. The tier 2 e2e test also passed on dockerd 29.9.3 for Linux in Docker-in-Docker, as a non-root user. Docker Desktop and Windows hosts are untested.
