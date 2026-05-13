# Codex Agent Support Chunk 6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use agentfiles:subagent-driven-development or agentfiles:executing-plans to implement this plan task-by-task. Keep changes inside the plan boundary.

**Goal:** Enable selected `agent=codex` launches while preserving Claude as the default runtime.
**Upstream context:** `docs/plans/2026-05-13-codex-agent-support.md` Chunk 6 and `docs/specs/2026-05-13-codex-agent-support-architecture.md`.
**In scope:** launch phase ordering, Codex workspace/version/auth validation, selected command/env/mount wiring, selected-only Claude refresh behavior, Codex resume rejection, and launch docs.
**Out of scope:** Codex rollout copy-back, agent-aware attach/inspect/doctor behavior, and new Dockerfile or entrypoint behavior beyond consuming the existing command contract.
**Done when:** `ccairgap --agent codex` reaches Docker with validated Codex state and command args, invalid Codex launches fail before session materialization, and the documented verification commands pass.

---

## Current Reality

Chunks 1-5 have already introduced `AgentKind`, Codex passthrough validation, dual-agent image contracts, Codex state materialization, and Codex mount inputs. `src/launch.ts` still exits with `agent=codex is accepted but runtime launch is disabled in this build` immediately after Codex arg validation, before session id generation, credential probing, state materialization, image resolution, mounts, or Docker execution.

`src/agentCommand.ts` already returns the selected-agent environment contract (`CCAIRGAP_AGENT`, optional `CCAIRGAP_PRINT`) and validated argv tail. `src/codexState.ts` materializes `$SESSION/codex-home`, `$SESSION/codex-auth`, and `$SESSION/codex-sessions`. `src/mounts.ts` can mount those paths through `agentMounts.codex`. `src/image.ts` exposes `defaultImageBuildArgs()` and `validateExpectedCodexVersion()`. `src/imageContract.ts` inspects the resolved image for both agent binaries, supported Codex version, and required Codex mount targets.

## Contracts and Invariants

- Claude remains the default selected agent and keeps existing ro-only/no-repo behavior.
- Codex requires a workspace repo before side effects. `--bare --repo <path>` is allowed; `--bare` without `--repo`, ro-only without repo, and no-repo launches are rejected before `$SESSION` creation.
- `--resume` remains Claude-only and must be rejected for selected Codex before session materialization.
- Selected Codex auth failures are fatal before session materialization unless print mode has `CODEX_API_KEY`; peer Claude credentials are advisory and must not refresh host auth.
- Selected Claude keeps pre-launch refresh and the runtime auth watcher. Selected Codex must not run Claude host refresh or start the runtime watcher.
- Codex image/build version validation happens before image pull/build when `CODEX_VERSION` is an exact unsupported version; image contract inspection still verifies non-exact or custom image results after image resolution.
- Docker env/argv must come from `agentCommandPlan()` using only validated selected-agent args.
- Manifest v1 remains compatible and records `agent: "codex"` plus `codex.host_home` when Codex state exists.

## Verification Plan

- `npm test -- src/launch.test.ts src/runtimeAuthRefresh.test.ts src/authRefresh.test.ts src/resume.test.ts src/resumeResolver.test.ts`
- `npm test`
- `npm run typecheck`

## Tasks

### Task 1: Replace the Codex Staging Guard With Phase-Ordering Tests

**Purpose:** Lock in the pre-side-effect failure boundary before enabling Codex.

**Files:**
- Modify: `src/launch.test.ts`

**Acceptance criteria:**
- Tests prove invalid Codex args, unsupported exact `CODEX_VERSION`, no repo, ro-only/no-repo, `--bare` without repo, `--resume`, and selected Codex auth failure exit before `generateId()`, image resolution, Docker, handoff, and `$SESSION` creation.
- Tests preserve the existing assertion that Codex image path validation sees `--cp` directory roots, but no longer expects the staged disabled message.

**Implementation notes:**
- Keep mocks narrow and reset modules between isolated launch imports.
- Assert absence of side effects through both mock call counts and empty/missing `CCAIRGAP_HOME/sessions`.

**Verification:**
- `npm test -- src/launch.test.ts`
- Expected: fails before implementation because Codex still exits at the staging guard.

### Task 2: Add Successful Codex Launch Wiring Tests

**Purpose:** Define the Docker, manifest, mount, and auth behavior for selected Codex.

**Depends on:** Task 1

**Files:**
- Modify: `src/launch.test.ts`

**Acceptance criteria:**
- Tests prove default Claude ro-only/no-repo compatibility remains.
- Tests prove `agent=codex --bare --repo <path>` and normal workspace Codex launches reach Docker.
- Tests prove Codex Docker args include `CCAIRGAP_AGENT=codex`, `CODEX_HOME=/home/claude/.codex`, Codex state mounts, validated Codex argv tail, and no Claude runtime watcher side effects.
- Tests prove `CODEX_API_KEY` is forwarded only for Codex print mode and bypasses mandatory host `auth.json`.
- Tests prove advisory Claude credentials can be absent for Codex without failing launch.

**Implementation notes:**
- Reuse the local fake-docker pattern in `src/launch.test.ts`.
- Inspect `manifest.json` in the created session to assert `agent` and `codex.host_home`.

**Verification:**
- `npm test -- src/launch.test.ts`
- Expected: fails before implementation because Codex launch is still disabled.

### Task 3: Wire Selected-Agent Launch Phases

**Purpose:** Enable Codex launch through the existing provider modules while keeping validation before side effects.

**Depends on:** Task 2

**Files:**
- Modify: `src/launch.ts`

**Acceptance criteria:**
- The launch sequence visibly resolves selected agent, validates selected args, validates Codex workspace and expected Codex build version, validates selected auth, probes peer auth, materializes both provider states, writes manifest, ensures and inspects image, builds mounts, and runs Docker.
- Selected Codex uses `validateCodexArgs()`, `materializeCodexState()`, `resolveCodexHome()`, `agentCommandPlan()`, `inspectImageContract()`, and Codex `agentMounts`.
- Selected Claude continues using `validateClaudeArgs()`, `resolveCredentials()`, and the existing Claude command tail.
- Exact unsupported `CODEX_VERSION` fails before `ensureImage()`.

**Implementation notes:**
- Do not move Docker execution into provider modules.
- Use `materializeAdvisoryCredentials()` for non-selected Claude and surface warning-only failures.
- Treat `CODEX_API_KEY` in Codex print mode as selected auth for this launch, while still allowing safe host `auth.json` to be copied when available.

**Verification:**
- `npm test -- src/launch.test.ts`
- Expected: pass for launch wiring tests.

### Task 4: Gate Claude Runtime Refresh and Resume Paths

**Purpose:** Make selected-only Claude behavior explicit in auth refresh and resume coverage.

**Depends on:** Task 3

**Files:**
- Modify: `src/launch.ts`
- Modify: `src/runtimeAuthRefresh.test.ts`
- Modify: `src/authRefresh.test.ts`
- Modify: `src/resume.test.ts`
- Modify: `src/resumeResolver.test.ts`

**Acceptance criteria:**
- Selected Codex launches never call `resolveCredentials()` or `startRuntimeAuthRefresh()`.
- Selected Claude behavior remains unchanged in existing auth refresh and resume tests.
- Codex resume requests fail before session materialization and do not resolve or copy Claude transcripts.

**Implementation notes:**
- Prefer launch-level tests for selected-agent gating; only change lower-level tests when an existing boundary requires it.

**Verification:**
- `npm test -- src/runtimeAuthRefresh.test.ts src/authRefresh.test.ts src/resume.test.ts src/resumeResolver.test.ts`
- Expected: pass.

### Task 5: Update Launch Docs and Recipe State

**Purpose:** Document the newly enabled user-visible Codex launch behavior in the same slice.

**Depends on:** Task 4

**Files:**
- Modify: `README.md`
- Modify: `docs/SPEC.md`
- Modify: `docs/flags.md`
- Modify: `docs/auth-refresh.md`
- Modify: `docs/codex.md`
- Modify: `docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md`

**Acceptance criteria:**
- Docs state Claude is still default and Codex is opt-in with `--agent codex`.
- Docs describe Codex workspace requirements, selected-only Claude refresh/watch behavior, Codex print-mode `CODEX_API_KEY` forwarding, and pre-side-effect validation.
- Recipe `Current chunk` advances from Chunk 6 to Chunk 7 before commit.

**Verification:**
- `npm test -- src/launch.test.ts src/runtimeAuthRefresh.test.ts src/authRefresh.test.ts src/resume.test.ts src/resumeResolver.test.ts`
- `npm test`
- `npm run typecheck`
- Expected: pass.

## Commit

Use:

```bash
git add src/launch.ts src/launch.test.ts src/runtimeAuthRefresh.ts src/runtimeAuthRefresh.test.ts src/authRefresh.ts src/authRefresh.test.ts src/resume.ts src/resume.test.ts src/resumeResolver.ts src/resumeResolver.test.ts README.md docs/SPEC.md docs/flags.md docs/auth-refresh.md docs/codex.md docs/plans/2026-05-13-codex-agent-support-chunk-6.md docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md
git commit -m "feat(launch): enable selected codex runtime"
```
