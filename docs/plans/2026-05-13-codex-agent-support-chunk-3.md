# Codex Agent Support Chunk 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use agentfiles:subagent-driven-development or agentfiles:executing-plans to implement this plan task-by-task. Keep changes inside the plan boundary.

**Goal:** Add the dual-agent Docker image, entrypoint dry-run branch selection, image contract checks, and TypeScript command contract for Claude and Codex.
**Upstream context:** `docs/plans/2026-05-13-codex-agent-support.md` Chunk 3, `docs/specs/2026-05-13-codex-agent-support-architecture.md`, `docs/specs/2026-05-12-codex-agent-support-design.md`.
**In scope:** `agentCommand.ts`, `imageContract.ts`, Dockerfile/entrypoint dual-agent setup, image version helpers, Dockerfile invariant tests, fake-image entrypoint dry-run e2e, and matching docs.
**Out of scope:** Enabling normal Codex runtime launch from `src/launch.ts`, Codex auth/home/state materialization, Codex mounts, Codex handoff, and Codex resume.
**Done when:** Chunk 3 verification passes, `docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md` points to Chunk 4, and the chunk is committed with `feat(runtime): add dual-agent image contract`.

---

## Current reality

`src/agent.ts` already defines `AgentKind` and `AgentMode`. `src/codexArgs.ts` validates Codex passthrough args but `src/launch.ts` still rejects `agent=codex` before session materialization. That staged rejection must remain unchanged in this chunk.

`src/image.ts` currently hashes the default Dockerfile plus `docker/entrypoint.sh` into the default image tag, builds images with arbitrary build args, and exposes `hostClaudeVersion()`. It does not expose Codex version constants or validate expected Codex image versions yet.

`docker/Dockerfile` installs Claude Code only through `CLAUDE_CODE_VERSION=latest`, pre-creates Claude bind targets, and makes `/home/claude` UID-portable. `docker/entrypoint.sh` prepares Claude state and always execs `claude`, with `CCAIRGAP_TEST_CMD` as an early-exit backdoor before the final exec branch.

`e2e/fixtures/fake.Dockerfile` has a minimal inline entrypoint for `CCAIRGAP_TEST_CMD`; it does not copy the real entrypoint or provide fake `claude`/`codex` binaries.

## Research gate result

The current upstream Codex CLI installation surface is `npm install -g @openai/codex` from the official `openai/codex` README. The architecture spec's checked baseline remains `codex-cli 0.130.0`, and current release/package search evidence still supports `0.130.0` as the stable supported pin for this chunk. Use `CODEX_VERSION=0.130.0` as the default Docker build arg and supported exact version.

## Contracts and invariants

- Claude remains the default selected command; existing Claude entrypoint behavior and `CCAIRGAP_TEST_CMD` semantics remain intact.
- Codex launch through the normal CLI remains disabled before Docker until a later chunk changes `src/launch.ts`.
- `agentCommand.ts` receives already validated provider argv and only translates agent/mode into `CCAIRGAP_AGENT`, optional `CCAIRGAP_PRINT`, and argv.
- The entrypoint prepares both `$HOME/.claude` and `$CODEX_HOME` before branching.
- `CODEX_HOME` defaults to `/home/claude/.codex` and must be visible in dry-run output.
- Codex interactive dry-run command is `codex --dangerously-bypass-approvals-and-sandbox --cd "$CCAIRGAP_CWD" "$@"`.
- Codex print dry-run command is `codex exec --dangerously-bypass-approvals-and-sandbox --cd "$CCAIRGAP_CWD" "$@" "$CCAIRGAP_PRINT"`.
- Default image identity continues to depend on Dockerfile content, entrypoint content, and `ccairgap` CLI version. Build args alone do not change tag identity.
- Custom images must satisfy the dual-agent runtime contract before they can be trusted by later chunks.

## Verification plan

- `npm test -- src/agentCommand.test.ts src/image.test.ts src/imageContract.test.ts src/dockerfileInvariants.test.ts`
- `npm run test:e2e:tier2 -- e2e/tier2/entrypoint-agent-dry-run.e2e.ts`
- `npm run typecheck`
- E2E may skip only through the existing Docker availability helper when Docker is unavailable.

## Tasks

### Task 1: Command Contract Tests And Skeleton

**Purpose:** Define the TypeScript selected-agent command contract without changing launch behavior.
**Files:**
- Create: `src/agentCommand.ts`
- Test: `src/agentCommand.test.ts`

**Acceptance criteria:**
- Tests cover Claude interactive and print plans, preserving the current Claude argv shape and setting `CCAIRGAP_AGENT=claude`.
- Tests cover Codex interactive setting `CCAIRGAP_AGENT=codex` and returning only validated argv tail.
- Tests cover Codex print setting `CCAIRGAP_PRINT` and keeping validated argv separate from the prompt.
- Tests prove this module rejects a raw/unvalidated argv marker, using a branded validated argv input or equivalent compile/runtime boundary.

**Implementation notes:**
- Export `AgentCommandPlan` with `{ agent: AgentKind; env: Record<string, string>; argv: string[] }`.
- Export a small helper for branding validated argv if needed; do not re-implement Claude or Codex arg validation here.
- Do not import Docker helpers or mutate `launch.ts`.

**Verification:**
- `npm test -- src/agentCommand.test.ts`
- Expected before production implementation: failing tests or skeleton behavior only.

### Task 2: Dockerfile And Entrypoint Contract

**Purpose:** Make the default image and entrypoint dual-agent while preserving Claude behavior.
**Depends on:** Task 1
**Files:**
- Modify: `docker/Dockerfile`
- Modify: `docker/entrypoint.sh`
- Modify/Test: `src/dockerfileInvariants.test.ts`
- Modify: `e2e/fixtures/fake.Dockerfile`

**Acceptance criteria:**
- Dockerfile defines `ARG CODEX_VERSION=0.130.0` and installs `@openai/codex@${CODEX_VERSION}` with npm.
- Dockerfile still installs Claude Code, does not install `xclip` or `wl-clipboard`, and keeps `/home/claude` UID-portable.
- Dockerfile pre-creates `/home/claude/.claude`, `/home/claude/.claude/projects`, `/home/claude/.codex`, `/home/claude/.codex/sessions`, and an auth-file parent for `/home/claude/.codex/auth.json`.
- Entrypoint prepares both homes, exports or respects `CODEX_HOME`, configures git identity and trusted cwd once, preserves `CCAIRGAP_TEST_CMD`, and branches on `CCAIRGAP_AGENT`.
- `CCAIRGAP_ENTRYPOINT_DRY_RUN=1` prints branch, selected command, cwd, `CCAIRGAP_AGENT`, `CCAIRGAP_PRINT` when set, `CODEX_HOME`, and whether Claude/Codex home targets exist, then exits before exec.
- Fake Dockerfile provides fake `claude` and `codex` executables and mirrors the real entrypoint's dry-run branch contract. Keep it self-contained because existing custom-Dockerfile e2e builds use `e2e/fixtures` as the Docker context.

**Implementation notes:**
- Default `CCAIRGAP_AGENT` to `claude` inside the entrypoint for direct image use and backward compatibility.
- Keep Claude final exec equivalent to the current command shape.
- Place dry-run after setup, cwd selection, name/resume calculation, and branch command construction, but before final exec.

**Verification:**
- `npm test -- src/dockerfileInvariants.test.ts`
- Expected: PASS after Dockerfile and entrypoint implementation.

### Task 3: Image Version And Contract Helpers

**Purpose:** Add pure image-version helpers and runtime image contract inspection for later launch integration.
**Depends on:** Task 2
**Files:**
- Create: `src/imageContract.ts`
- Test: `src/imageContract.test.ts`
- Modify: `src/image.ts`
- Modify/Test: `src/image.test.ts`

**Acceptance criteria:**
- `src/image.ts` exports a supported Codex version constant set to `0.130.0`.
- A pure helper normalizes Codex version output such as `codex-cli 0.130.0` to `0.130.0`.
- A pure helper validates expected exact `CODEX_VERSION` pins and rejects unsupported exact semver before image pull/build or session materialization.
- Build arg default helper includes `CLAUDE_CODE_VERSION` and `CODEX_VERSION`; caller-provided build args override defaults.
- Image tag tests prove default tag identity changes when Dockerfile, entrypoint, or CLI version changes, and build args alone do not enter the tag hash.
- `imageContract.ts` can inspect an image through injectable command execution and report missing `claude`, missing `codex`, unsupported Codex version, missing mount targets, and non-UID-portable mount permissions.

**Implementation notes:**
- Keep command execution injectable so unit tests do not require Docker.
- Do not call image contract inspection from `src/launch.ts` in this chunk.
- A range or dist-tag build arg may produce a warning result for custom image inspection risk; unsupported exact semver pins should be a failing result.

**Verification:**
- `npm test -- src/image.test.ts src/imageContract.test.ts`
- Expected: PASS.

### Task 4: Entry Point Dry-Run E2E

**Purpose:** Add Docker-backed coverage for the real entrypoint branch selection with the fake image.
**Depends on:** Task 2
**Parallel with:** Task 3
**Files:**
- Create: `e2e/helpers/entrypointDryRun.ts`
- Create/Test: `e2e/tier2/entrypoint-agent-dry-run.e2e.ts`
- Modify: `e2e/README.md`

**Acceptance criteria:**
- Helper builds or reuses the fake image and runs it with `CCAIRGAP_ENTRYPOINT_DRY_RUN=1`.
- Tests cover `agent=claude`, `agent=codex` interactive, and `agent=codex` print.
- Tests assert branch, command, cwd, shell-safe argument preservation, `CCAIRGAP_AGENT`, `CCAIRGAP_PRINT`, `CODEX_HOME`, and both home preparations.
- Tests skip only when `dockerAvailable()` reports Docker unavailable.
- E2E README explains how `CCAIRGAP_ENTRYPOINT_DRY_RUN=1` differs from `CCAIRGAP_TEST_CMD`.

**Implementation notes:**
- This e2e should invoke Docker directly against `e2e/fixtures/fake.Dockerfile`; do not route through normal `ccairgap --agent codex` because launch remains disabled.
- Use `execa` argv arrays, not shell command strings, for Docker invocation.

**Verification:**
- `npm run test:e2e:tier2 -- e2e/tier2/entrypoint-agent-dry-run.e2e.ts`
- Expected: PASS or SKIP only when Docker is unavailable.

### Task 5: Documentation, Recipe Advance, Review, And Commit

**Purpose:** Document public/runtime surfaces, advance the chunk recipe, and perform final verification.
**Depends on:** Task 3 and Task 4
**Files:**
- Modify: `docs/SPEC.md`
- Modify: `docs/dockerfile.md`
- Modify: `docs/env-vars.md`
- Modify: `e2e/README.md`
- Modify: `docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md`

**Acceptance criteria:**
- Docs describe the dual-agent image, `CODEX_VERSION`, `CODEX_HOME`, `CCAIRGAP_AGENT`, `CCAIRGAP_PRINT`, and `CCAIRGAP_ENTRYPOINT_DRY_RUN`.
- Docs state Claude remains the default and normal Codex runtime launch is still staged until later chunks.
- Recipe current chunk is advanced from `Chunk 3` to `Chunk 4`.
- Spec compliance review confirms every Chunk 3 requirement is implemented and no later-chunk Codex launch path was enabled.
- Code quality review confirms tests assert behavior and follow existing repo patterns.
- Commit message is exactly `feat(runtime): add dual-agent image contract`.

**Verification:**
- `npm test -- src/agentCommand.test.ts src/image.test.ts src/imageContract.test.ts src/dockerfileInvariants.test.ts`
- `npm run test:e2e:tier2 -- e2e/tier2/entrypoint-agent-dry-run.e2e.ts`
- `npm run typecheck`
- `git status --short`
- Expected: PASS, or e2e SKIP only when Docker is unavailable.
