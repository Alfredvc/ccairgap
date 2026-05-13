# Codex Passthrough Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use agentfiles:subagent-driven-development or agentfiles:executing-plans to implement this plan task-by-task. Keep changes inside the plan boundary.

**Goal:** Implement Chunk 2 from `docs/plans/2026-05-13-codex-agent-support.md`: pure, mode-aware Codex passthrough validation plus early launch wiring while Codex runtime remains disabled.
**Upstream context:** `docs/plans/2026-05-13-codex-agent-support.md`, `docs/specs/2026-05-13-codex-agent-support-architecture.md`, `docs/specs/2026-05-12-codex-agent-support-design.md`.
**In scope:** `src/codexArgs.ts`, `src/codexArgs.test.ts`, minimal `src/launch.ts`/`src/launch.test.ts` early-validation wiring, and docs for accepted/denied Codex passthrough surfaces.
**Out of scope:** Docker/entrypoint command construction, Codex auth/state materialization, image contracts, mount builder changes, and enabling Codex runtime launch.
**Done when:** `npm test -- src/codexArgs.test.ts src/launch.test.ts` passes, docs describe Codex passthrough policy, and `agent=codex` still exits before side effects.

---

## Current reality

Chunk 1 is committed. `src/agent.ts` defines `AgentKind` and `AgentMode`; `LaunchOptions` in `src/launch.ts` has `agent?: AgentKind` and `codexArgs?: string[]`. `launch()` currently resolves `selectedAgent` after repo/RO overlap validation and immediately rejects `codex` before `validateClaudeArgs()`, ID generation, orphan scan, credentials, session directory creation, Docker, or handoff. `src/claudeArgs.ts` is a denylist-style validator; Codex needs a separate allowlist validator.

`src/artifacts.ts` shows container-visible path rules for `--cp`, `--sync`, and `--mount`: their container paths are the resolved absolute host path, while `--cp`/`--sync` may be materialized under the session dir later. For Chunk 2, the Codex validator must remain pure and can receive caller-computed visible roots/paths instead of resolving artifacts itself.

The Codex source snapshot checked for this plan is the local checkout at `/Users/alfredvc/src/codex` plus current upstream GitHub `openai/codex` as of 2026-05-13. Relevant files: `codex-rs/cli/src/main.rs`, `codex-rs/tui/src/cli.rs`, `codex-rs/utils/cli/src/shared_options.rs`, and `codex-rs/exec/src/cli.rs`. These sources confirm the top-level subcommands, shared flags, interactive flags, and exec-mode flags listed in the parent design.

## Contracts and invariants

- Codex validation is fail-closed: any unknown flag or denied subcommand/flag is a hard error.
- Codex validation is pure: no filesystem reads/writes, no Docker, no launch option mutation.
- `AgentMode` controls the allowed surface: interactive Codex allows TUI-safe flags and at most one positional prompt; print mode allows exec-safe flags and no extra positional prompt from passthrough.
- `-- -p` in the selected-agent tail means Codex `--profile` and must be denied; ccairgap `-p/--print` before `--` is already represented by `AgentMode.print`.
- User-supplied Codex bypass/sandbox/approval/workspace/config flags are denied because ccairgap owns those runtime choices.
- `--image`/`-i` values must be container-visible through explicit roots/paths supplied by `launch.ts`; host-only image paths are rejected.
- `agent=codex` remains runtime-disabled after validation. Invalid Codex args must surface before the staged disabled message.
- Claude behavior and Claude arg validation remain unchanged.

## Verification plan

- `npm test -- src/codexArgs.test.ts` must first fail before `src/codexArgs.ts` exists, then pass after implementation.
- `npm test -- src/launch.test.ts` must prove invalid Codex args fail before the staged disabled message and before session materialization, while valid Codex args still reach the staged disabled guard.
- Final command: `npm test -- src/codexArgs.test.ts src/launch.test.ts`.

### Task 1: Codex Args Test Suite and Skeleton

**Purpose:** Create the behavioral contract for Codex passthrough validation before production implementation.
**Files:**
- Create: `src/codexArgs.test.ts`
- Create: `src/codexArgs.ts`

**Acceptance criteria:**
- Tests record the checked Codex version/source snapshot in a top-level comment or fixture constant.
- Tests cover interactive safe flags: `--image`/`-i`, `--model`/`-m`, `--search`, `--no-alt-screen`, and one optional positional prompt.
- Tests cover print safe flags: `--image`/`-i`, `--model`/`-m`, `--output-schema`, `--color`, `--output-last-message`/`-o`, and `--json`.
- Tests cover top-level subcommand denies from the parent design.
- Tests cover shared unsafe flag denies from the parent design, including user-supplied bypass aliases.
- Tests cover exec-mode extra denies: `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, `--skip-git-repo-check`, and hidden `--full-auto`.
- Tests cover ccairgap print mode versus Codex `-p/--profile`.
- Tests cover unknown flags failing closed.
- Tests reject missing values for value-taking flags: `--model`, `--image`, `--output-schema`, `--color`, and `--output-last-message`.
- Tests reject more than one interactive positional prompt.
- Tests reject any print-mode passthrough positional prompt.
- Tests reject a bare `--` token.
- Tests cover `--image` host-only paths versus visible paths.
- Skeleton exports the planned validator signature and types so the test file typechecks but runtime assertions fail.

**Implementation notes:**
- Name the exported function `validateCodexArgs`.
- Use `AgentMode` from `src/agent.ts`.
- Use a structured error type or ordinary `Error`; tests should assert clear messages rather than private implementation details.
- Keep the skeleton minimal: placeholder implementation may return the input argv or throw generic errors only to establish red tests.

**Verification:**
- `npm test -- src/codexArgs.test.ts`
- Expected before production implementation: FAIL because validation is not implemented.

### Task 2: Pure Codex Args Validator

**Purpose:** Replace the skeleton with a complete fail-closed, mode-aware validator.
**Depends on:** Task 1
**Files:**
- Modify: `src/codexArgs.ts`

**Acceptance criteria:**
- `validateCodexArgs()` accepts resolved `AgentMode`, the already-merged `LaunchOptions.codexArgs` array, and container-visible roots/paths. `src/cli.ts` already merges config first and CLI tail second, so this slice must not widen the launch boundary to carry separate sources.
- It returns only validated argv, preserving the incoming merged order.
- It consumes values for known value-taking flags and supports inline values such as `--model=gpt-5-codex`.
- It preserves comma-delimited `--image a,b` as one Codex argument but validates each path segment for visibility.
- It hard-denies the full top-level subcommand list from the design: `exec`/`e`, `review`, `login`, `logout`, `mcp`, `plugin`, `mcp-server`, `app-server`, `remote-control`, `app`, `completion`, `update`, `sandbox`, `debug`, `execpolicy`, `apply`/`a`, `resume`, `fork`, `cloud`/`cloud-tasks`, `responses-api-proxy`, `stdio-to-uds`, `exec-server`, and `features`.
- It hard-denies shared unsafe flags from the design: `--cd`/`-C`, `--add-dir`, `--config`/`-c`, `--profile`/`-p`, `--enable`, `--disable`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--remote`, `--remote-auth-token-env`, `--oss`, `--local-provider`, `--dangerously-bypass-approvals-and-sandbox`, `--yolo`, and `--full-auto`.
- It hard-denies exec-only unsafe flags in print mode: `--ignore-user-config`, `--ignore-rules`, `--ephemeral`, and `--skip-git-repo-check`.
- Interactive mode allows only TUI-safe flags plus at most one positional prompt.
- Print mode allows only exec-safe flags and rejects positional passthrough prompts because the prompt comes from `AgentMode.print`.
- Error messages identify the offending token and, where useful, the canonical flag.

**Implementation notes:**
- Prefer small token helpers modeled after `src/claudeArgs.ts`, but keep Codex allowlist semantics separate.
- Treat bare `--` in the selected-agent tail as invalid because ccairgap already consumed its own separator.
- Do not import launch, artifacts, paths, Docker, or filesystem modules.

**Verification:**
- `npm test -- src/codexArgs.test.ts`
- Expected: PASS.

### Task 3: Early Launch Wiring

**Purpose:** Run Codex arg validation in launch before the existing runtime-disabled rejection.
**Depends on:** Task 2
**Files:**
- Modify: `src/launch.ts`
- Modify: `src/launch.test.ts`

**Acceptance criteria:**
- `launch()` validates Codex args when `opts.agent === "codex"` after repo/RO realpath overlap validation and before the staged disabled guard.
- Invalid Codex args print validation errors and exit before `generateId`, `scanOrphans`, `resolveCredentials`, `ensureImage`, Docker, handoff, or session directory creation.
- Valid Codex args still produce `agent=codex is accepted but runtime launch is disabled in this build`.
- Launch passes a conservative container-visible path set to the validator using already-available inputs.
- Add a pure helper, either in `launch.ts` or `codexArgs.ts`, equivalent to `deriveCodexVisiblePaths({ repos, ros, cp, sync, mount, bare, cwd })`: it resolves repo roots and `--ro` with the existing `realpath`, resolves raw `--cp`/`--sync`/`--mount` values against `opts.bare ? process.cwd() : workspaceRepo`, validates existence with `realpath`, returns container-visible absolute roots/paths, and does not require `sessionDir` or call `resolveArtifacts()`.
- Claude-selected launch continues to validate only `claudeArgs` and ignores `codexArgs`.

**Implementation notes:**
- Avoid broad artifact refactors. If a tiny pure helper is needed to derive candidate container-visible paths for Codex image validation, keep it local to `launch.ts` or export it from `codexArgs.ts`.
- Existing `launch.test.ts` has an `agent=codex` staged guard test with mocks. Extend that pattern for invalid Codex args and keep assertions against side-effect mocks.
- Do not append validated Codex args to Docker yet; Chunk 3/6 own runtime command construction.

**Verification:**
- `npm test -- src/launch.test.ts`
- Expected: PASS.

### Task 4: Documentation and Recipe Advancement

**Purpose:** Document the new Codex passthrough policy and prepare the recipe for the next session.
**Depends on:** Task 3
**Files:**
- Create: `docs/codex.md`
- Modify: `docs/flags.md`
- Modify: `docs/claude-args.md`
- Modify: `docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md`
- Modify: `docs/plans/2026-05-13-codex-passthrough-validation.md`

**Acceptance criteria:**
- `docs/codex.md` explains that Codex runtime is still disabled, but Codex passthrough is now validated before the disabled guard.
- `docs/codex.md` lists allowed interactive flags, allowed print flags, denied subcommands/unsafe flags, and `--image` visibility rules.
- `docs/flags.md` points `-- <selected-agent-args...>` and `--agent` readers to `docs/codex.md`.
- `docs/claude-args.md` explains that selected-agent passthrough is Claude denylist validation or Codex allowlist validation depending on `--agent`.
- The implementation recipe’s `Current chunk` changes from `Chunk 2` to `Chunk 3` only after code and docs verification pass.

**Implementation notes:**
- Do not claim Codex launch works in this chunk.
- Keep docs concise and consistent with existing Markdown style.

**Verification:**
- `npm test -- src/codexArgs.test.ts src/launch.test.ts`
- Expected: PASS.

### Task 5: Final Review, Verification, and Commit

**Purpose:** Perform final checks, review the chunk diff, and commit exactly the chunk work.
**Depends on:** Task 4
**Files:**
- Modify only files changed by Tasks 1-4.

**Acceptance criteria:**
- Review confirms scope: no Docker runtime enablement, no auth/state materialization, no mount builder changes, and no CLI launch-boundary changes.
- Final verification passes: `npm test -- src/codexArgs.test.ts src/launch.test.ts`.
- Commit stages only Chunk 2 files and uses `feat(codex): validate selected codex args`.

**Verification:**
- `git diff --check`
- `npm test -- src/codexArgs.test.ts src/launch.test.ts`
- `git add src/codexArgs.ts src/codexArgs.test.ts src/launch.ts src/launch.test.ts docs/flags.md docs/claude-args.md docs/codex.md docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md docs/plans/2026-05-13-codex-passthrough-validation.md`
- `git commit -m "feat(codex): validate selected codex args"`
