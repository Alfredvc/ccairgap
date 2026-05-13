# ccairgap E2E Tests

End-to-end tests that spin up real Docker containers using a lightweight fake image (`e2e/fixtures/fake.Dockerfile`) — no real Claude Code binary required.

## Prerequisites

- Docker daemon running
- `npm run build` completed (the global setup does this automatically)
- For `smoke.sh` only: valid Claude Code credentials and network access

## Running

```sh
# All E2E tests
npm run test:e2e

# Tier 1 only (fast, container lifecycle basics)
npm run test:e2e:tier1

# Tier 2 only (slower, integration scenarios)
npm run test:e2e:tier2
```

## Test coverage

| Suite | Tier | What it covers |
|-------|------|----------------|
| `e2e/tier1/` | 1 | Container lifecycle: launch, exit, CCAIRGAP_TEST_CMD backdoor, entrypoint env wiring |
| `e2e/tier2/` | 2 | Integration: repo cloning, mount correctness, handoff, recover, selected-agent entrypoint dry-run |

## Entrypoint dry-run

`CCAIRGAP_TEST_CMD` is the older early-exit test hook: after basic entrypoint setup it executes a shell command instead of launching the agent. It is useful for container lifecycle tests, but it exits before the Claude/Codex branch is selected.

`CCAIRGAP_ENTRYPOINT_DRY_RUN=1` runs setup, selects the final agent command, prints the branch, cwd, relevant env, home readiness, and shell-quoted command, then exits before `exec`. Tier 2 uses it with the fake image to verify `agent=claude`, `agent=codex`, and Codex print-mode branch selection without invoking real agent CLIs.

## Smoke test

`e2e/smoke.sh` launches the **real** CLI with a real Claude Code session against a throwaway repo. It is human-run only — not included in the automated suites. You eyeball the output and exit.

```sh
bash e2e/smoke.sh
```

Requires valid credentials and network. Do not run in CI.

## Cleanup

Remove any leftover containers from interrupted runs:

```sh
npm run test:e2e:cleanup
```

Remove the fake image built during test runs:

```sh
docker image prune --filter label=ccairgap-e2e=true
```
