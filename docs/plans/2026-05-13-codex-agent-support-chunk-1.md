# Codex Agent Support Chunk 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use agentfiles:subagent-driven-development or agentfiles:executing-plans to implement this plan task-by-task. Keep changes inside the plan boundary.

**Goal:** Add the shared selected-agent config/CLI/manifest surface while keeping Claude as the default and keeping Codex launch disabled before side effects.
**Upstream context:** `docs/plans/2026-05-13-codex-agent-support.md` Chunk 1, `docs/specs/2026-05-13-codex-agent-support-architecture.md`, `docs/specs/2026-05-12-codex-agent-support-design.md`.
**In scope:** `src/agent.ts`, config and layered merge support for `agent`/`codex-args`, launch CLI `--agent`, selected-agent passthrough naming, manifest optional fields/helper, completion entries, inert Codex launch rejection, and matching docs.
**Out of scope:** Codex arg allowlist/denylist validation, Docker/runtime command changes, Codex state/auth/home materialization, attach agent selection, resume support for Codex, and enabling Codex inside Docker.
**Done when:** The Chunk 1 verification command passes, `docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md` points to Chunk 2, and the chunk is committed with `feat(agent): add selected agent config surface`.

---

## Current reality

`src/cli.ts` owns the default launch command, splits a raw post-`--` tail with `splitClaudeArgs()`, merges CLI over layered config in `mergeRun()`, and calls `launch()`. `src/cliSplit.ts` keeps the split behavior isolated for tests. `src/config.ts` parses YAML into `ConfigFile`, and `src/configLayered.ts` classifies every config key into scalar, array, or special merge buckets with a compile-time exhaustiveness check.

`src/launch.ts` already has a validation phase before session id/session directory creation. It validates host binaries, repo/ro overlap, Claude arg passthrough, and resume sources before materializing `$SESSION`; this is the right place for Chunk 1's generic `agent=codex` disabled rejection. `src/manifest.ts` keeps manifest `version: 1` with additive optional fields. `src/completion.ts` derives launch flags from Commander options and can return static value candidates based on the previous word.

Existing baseline tests are colocated under `src/*.test.ts`. Chunk 0 has already added `src/manifest.test.ts` and the Codex staging guardrail in `CLAUDE.md`.

## Contracts and invariants

- Claude remains the default when config and CLI omit `agent`.
- CLI `--agent` overrides config `agent`; config layers merge scalar `agent` by existing precedence.
- `codex-args` is accepted and layered like `claude-args`, but is not validated or launched until later chunks.
- The post-`--` tail split behavior is unchanged; only selected-agent naming is introduced where useful.
- `agent=codex` must fail before session directory creation, repo clone, credential materialization, orphan scanning, image build/pull, Docker run, and handoff.
- `--resume` remains Claude-only in Chunk 1; Codex launch rejection can happen before resume resolution.
- Manifest version stays `1`; absent `manifest.agent` is interpreted as `claude`.
- Documentation must say Codex is accepted as a selected-agent surface but runtime launch is still disabled until a later chunk.

## Verification plan

- `npm test -- src/agent.test.ts src/cli.test.ts src/config.test.ts src/configLayered.test.ts src/manifest.test.ts src/completion.test.ts src/launch.test.ts`
- `npm run typecheck`
- Final review should confirm Codex cannot reach Docker execution and Claude launch behavior remains unchanged by default.

## Tasks

### Task 1: Tests And Skeleton

**Purpose:** Add failing/characterization tests for the Chunk 1 surface and enough production skeleton for TypeScript to compile.

**Files:**
- Create: `src/agent.ts`
- Create/Test: `src/agent.test.ts`
- Modify/Test: `src/config.test.ts`
- Modify/Test: `src/configLayered.test.ts`
- Modify/Test: `src/cli.test.ts`
- Modify/Test: `src/manifest.test.ts`
- Modify/Test: `src/completion.test.ts`
- Modify/Test: `src/launch.test.ts`
- Modify skeleton as needed: `src/config.ts`, `src/configLayered.ts`, `src/cliSplit.ts`, `src/manifest.ts`, `src/completion.ts`, `src/launch.ts`, `src/cli.ts`

**Acceptance criteria:**
- `src/agent.test.ts` covers default Claude selection, config Codex selection, CLI override, unknown values with a clear message, mode construction for print/resume, and the exhaustive helper.
- Config tests cover `agent`/`codex-args` kebab and camel aliases, wrong types, invalid agent values, and path resolution leaving these fields unchanged.
- Layered config tests cover scalar `agent` precedence and array `codexArgs` provenance.
- CLI split tests prove the raw post-`--` tail is still ordered and exposed under selected-agent naming.
- Manifest tests cover optional `agent`, optional `codex`, and absent-agent-as-Claude helper behavior without bumping version.
- Completion tests cover `--agent` as a launch flag and `claude`/`codex` value candidates after `--agent`.
- Launch tests cover `agent: "codex"` exits with the staged disabled message and creates no session directory, while also proving credential resolution, orphan scanning, image resolution, Docker runtime execution, and handoff are not reached.
- Skeleton production changes may be incomplete at runtime only where Task 2 will finish behavior; tests should express the intended final behavior and may fail after this task.

**Implementation notes:**
- Keep the public type boundary from the architecture spec:
  `AgentKind = "claude" | "codex"`, `AgentMode`, and `AgentSelection`.
- Name the new split helper `splitSelectedAgentArgs()` and preserve a backwards-compatible `splitClaudeArgs()` wrapper during this chunk so existing imports do not churn unnecessarily.
- Do not add Codex argument validation or Docker command support.

**Verification:**
- `npm test -- src/agent.test.ts src/config.test.ts src/configLayered.test.ts src/cli.test.ts src/manifest.test.ts src/completion.test.ts src/launch.test.ts`
- `npm run typecheck`
- Expected after Task 1: tests may fail on incomplete production behavior, but `npm run typecheck` should pass.

### Task 2: Production Implementation

**Purpose:** Replace the skeleton with the real selected-agent parsing, merging, CLI, manifest, completion, and early launch rejection behavior without editing tests.

**Depends on:** Task 1

**Files:**
- Modify: `src/agent.ts`
- Modify: `src/config.ts`
- Modify: `src/configLayered.ts`
- Modify: `src/cliSplit.ts`
- Modify: `src/cli.ts`
- Modify: `src/manifest.ts`
- Modify: `src/completion.ts`
- Modify: `src/launch.ts`

**Acceptance criteria:**
- `parseAgentKind()` accepts only `claude` and `codex`; errors name the invalid value and allowed values.
- `resolveAgentSelection()` defaults to Claude, applies CLI over config, and builds an `AgentMode` from `agent`, `print`, and Claude-only `resume`.
- `ConfigFile` includes `agent?: AgentKind` and `codexArgs?: string[]`; `KEY_ALIASES`, `parseConfig()`, and `mergeLayers()` classify them correctly.
- `mergeRun()` carries `agent` and `codexArgs`; CLI `--agent <agent>` overrides config, while `codexArgs` layer config before future CLI selected-tail use.
- The default launch command exposes `--agent <claude|codex>` and passes `agent` plus the selected-agent tail into `launch()`. For this chunk, Claude receives the selected-agent tail as `claudeArgs`; Codex receives it as `codexArgs`.
- `LaunchOptions` accepts `agent` and `codexArgs`; `launch()` rejects `codex` immediately after host-binary/repo overlap validation and before any session id, directory, auth, orphan scan, image resolution, Docker execution, or handoff is reached.
- Manifest helper `readManifestAgent()` returns `claude` when the manifest omits `agent`.
- `candidatesFor("--agent", program)` returns `["claude", "codex"]`.

**Verification:**
- `npm test -- src/agent.test.ts src/cli.test.ts src/config.test.ts src/configLayered.test.ts src/manifest.test.ts src/completion.test.ts src/launch.test.ts`
- `npm run typecheck`
- Expected: PASS.

### Task 3: Documentation And Recipe Advance

**Purpose:** Update public and developer docs for the new inert selected-agent surface and advance the recipe to Chunk 2. Task 2 is not complete or mergeable until this documentation task lands in the same chunk checkpoint.

**Depends on:** Task 2

**Files:**
- Modify: `README.md`
- Modify: `docs/SPEC.md`
- Modify: `docs/flags.md`
- Modify: `docs/config.md`
- Modify: `docs/completion.md`
- Modify: `docs/claude-args.md`
- Modify: `CLAUDE.md`
- Modify: `docs/plans/2026-05-13-codex-agent-support-implementation-recipe.md`

**Acceptance criteria:**
- Docs state Claude is the default.
- Docs list `--agent claude|codex`, `agent: claude|codex`, and `codex-args`, while explicitly stating Codex runtime launch is disabled until later chunks.
- `docs/claude-args.md` explains the post-`--` tail as selected-agent passthrough and notes that Chunk 1 only applies it to Claude at runtime.
- `docs/completion.md` mentions `--agent` value completion.
- `CLAUDE.md` layout notes include `src/agent.ts` and selected-agent passthrough naming.
- Recipe current chunk is changed from `Chunk 1` to `Chunk 2`.

**Verification:**
- Re-run the Task 2 verification command.
- Manually review docs for any claim that Codex launch works in Chunk 1.

### Task 4: Final Review And Commit

**Purpose:** Review the whole chunk, fix real issues, then commit only the Chunk 1 files.

**Depends on:** Task 3

**Files:**
- All Chunk 1 changed files from Tasks 1-3.

**Acceptance criteria:**
- Spec compliance review confirms every Chunk 1 requirement is implemented and no later-chunk runtime behavior was added.
- Code quality review confirms changes follow existing local patterns and tests assert behavior rather than implementation details.
- Final verification passes.
- Commit message is exactly `feat(agent): add selected agent config surface`.

**Verification:**
- `npm test -- src/agent.test.ts src/cli.test.ts src/config.test.ts src/configLayered.test.ts src/manifest.test.ts src/completion.test.ts src/launch.test.ts`
- `npm run typecheck`
- `git status --short`
