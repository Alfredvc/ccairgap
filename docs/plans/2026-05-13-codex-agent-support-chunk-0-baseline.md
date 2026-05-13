# Codex Agent Support Chunk 0 Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use agentfiles:subagent-driven-development or agentfiles:executing-plans to implement this plan task-by-task. Keep changes inside the plan boundary.

**Goal:** Lock the current Claude-only behavior before Codex-facing surfaces are introduced.
**Upstream context:** `docs/plans/2026-05-13-codex-agent-support.md`, `docs/specs/2026-05-13-codex-agent-support-architecture.md`, and `docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md`.
**In scope:** Characterization tests for manifest v1, layered Claude passthrough args, launch passthrough splitting, and implementer staging guardrails in `CLAUDE.md`.
**Out of scope:** `--agent`, `agent`, `codex-args`, Docker changes, Codex state materialization, Codex launch behavior, and production code changes.
**Done when:** Targeted tests and typecheck pass, the recipe advances to Chunk 1, and the chunk is committed.

---

## Current Reality

`src/manifest.ts` writes pretty JSON with a trailing newline, reads `manifest.json`, and rejects unsupported versions with `UnknownManifestVersionError` while keeping manifest version `1`. `src/configLayered.test.ts` already covers scalar and array layer precedence for config merging. `src/cli.test.ts` imports `splitClaudeArgs` from `src/cliSplit.ts` and covers launch-only `--` passthrough behavior. `CLAUDE.md` has a `## When adding features` section for implementer rules.

## Contracts And Invariants

- Manifest v1 remains backward compatible: additive optional fields must not require a manifest version bump.
- Claude remains the default behavior and `claudeArgs` continues to layer in user-wide then project order.
- The launch `--` tail remains raw, ordered Claude passthrough until later chunks rename selected-agent concepts.
- Codex launch must remain unreachable before Chunk 6.
- This chunk must not modify runtime production modules or add Codex-facing CLI/config keys.

## Verification Plan

- `npm test -- src/manifest.test.ts`
- `npm test -- src/configLayered.test.ts`
- `npm test -- src/cli.test.ts`
- `npm test -- src/manifest.test.ts src/configLayered.test.ts src/cli.test.ts`
- `npm run typecheck`

## Tasks

### Task 1: Manifest V1 Baseline Tests

**Purpose:** Characterize existing manifest read/write compatibility before additive Codex manifest fields are introduced.

**Files:**
- Create: `src/manifest.test.ts`

**Acceptance Criteria:**
- The test writes a representative v1 manifest and verifies pretty JSON, trailing newline, parsed JSON equality, and `readManifest` equality.
- The test verifies an older v1 manifest without additive optional fields still reads unchanged.
- The test verifies unknown versions throw `UnknownManifestVersionError` and mention the unsupported version.

**Implementation Notes:**
- Import manifest helpers and `Manifest` from `src/manifest.ts`.
- Use temporary directories under `tmpdir()` and remove them in `afterEach`.
- These are characterization tests; they are expected to pass against current production code.

**Verification:**
- `npm test -- src/manifest.test.ts`
- Expected: pass.

### Task 2: Claude Passthrough Baseline Tests

**Purpose:** Lock current config layering and launch tail splitting behavior before selected-agent terminology changes.

**Depends On:** Task 1

**Files:**
- Modify: `src/configLayered.test.ts`
- Modify: `src/cli.test.ts`

**Acceptance Criteria:**
- `mergeLayers` has a test showing `claudeArgs` arrays concatenate in user-wide then project order and provenance records one source per array element.
- `splitClaudeArgs` has a test showing launch passthrough after `--` is preserved as a raw ordered tail.
- No production code is changed to make these tests pass.

**Implementation Notes:**
- Add the `claudeArgs` test inside `describe("mergeLayers", ...)`.
- Because array provenance is per element, assert `["user-wide", "project", "project"]` for `["--verbose", "--permission-mode", "plan"]`.
- Add the passthrough tail test inside `describe("splitClaudeArgs", ...)`.

**Verification:**
- `npm test -- src/configLayered.test.ts`
- `npm test -- src/cli.test.ts`
- Expected: pass.

### Task 3: Staging Guardrails And Recipe Advancement

**Purpose:** Document the Codex staging constraint for future implementers and advance the iteration recipe.

**Depends On:** Task 2

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md`
- Modify: `docs/plans/2026-05-13-codex-agent-support-chunk-0-baseline.md`

**Acceptance Criteria:**
- `CLAUDE.md` has a `### Codex Support Staging` section under `## When adding features`, before the numbered list.
- The section states that `agent=codex` must not reach Docker execution before Chunk 6 and Claude stays the default launch behavior.
- The implementation recipe updates `Current chunk` from Chunk 0 to Chunk 1 after verification.

**Verification:**
- `npm test -- src/manifest.test.ts src/configLayered.test.ts src/cli.test.ts`
- `npm run typecheck`
- Expected: pass.

## Final Review And Commit

Review the full diff for scope: only chunk 0 tests, docs, this detailed plan, and recipe advancement should change. Commit with:

```bash
git add src/manifest.test.ts src/configLayered.test.ts src/cli.test.ts CLAUDE.md docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md docs/plans/2026-05-13-codex-agent-support-chunk-0-baseline.md
git commit -m "test(agent): lock pre-codex baseline contracts"
```
