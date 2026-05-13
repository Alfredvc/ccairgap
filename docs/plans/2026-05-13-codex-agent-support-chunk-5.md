# Codex Agent Support Chunk 5 Implementation Plan

**Goal:** Add Codex state mount inputs and reserved-path collision coverage without enabling Codex runtime launch.
**Upstream context:** `docs/plans/2026-05-13-codex-agent-support.md` Chunk 5 and the Codex mount architecture in `docs/specs/2026-05-12-codex-agent-support-design.md`.
**In scope:** `src/mounts.ts`, `src/mountCollisions.ts`, mount/collision/docker-run-arg tests, and mount/raw-arg docs.
**Out of scope:** `launch.ts` wiring, Codex runtime enablement, and Codex handoff.
**Commit message:** `feat(mounts): add codex state mount inputs`

## Verification

- `npm test -- src/mounts.test.ts src/mountCollisions.test.ts src/dockerRunArgs.test.ts`
- `npm run typecheck`
- `npm test`

## Tasks

1. Add `ClaudeMountInputs`, `CodexMountInputs`, and `AgentMountInputs` types in `src/mounts.ts` while preserving the current `BuildMountsInput` call shape.
2. Add optional Codex mount inputs to `buildMounts()` that mount session Codex home/auth/sessions state into the container and expose neutral `/host-codex*` helper paths.
3. Add Codex reserved exact and prefix paths in `src/mountCollisions.ts`.
4. Add regression tests proving Claude mounts remain unchanged, Codex peer mounts are additive, selected-agent state is not part of mount assembly, and structured user mounts cannot shadow Codex paths.
5. Add raw docker arg ordering coverage and docs clarifying that raw docker args are appended after built-ins and are outside reserved-path guarantees.
