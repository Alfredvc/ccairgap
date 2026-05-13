# Codex Agent Support Chunk 4 Implementation Plan

**Goal:** Materialize sanitized Codex state without enabling Codex runtime launch.
**Upstream context:** `docs/plans/2026-05-13-codex-agent-support.md` Chunk 4 and `docs/specs/2026-05-13-codex-agent-support-architecture.md`.
**In scope:** Codex home resolution, auth sanitization, TOML/JSON config policy, project/user guidance overlays, state directory materialization, selected/advisory Claude credential split, dirty-tree exclusions, docs.
**Out of scope:** Launch wiring, Codex mounts, Codex handoff, Docker execution, Codex resume.
**Commit message:** `feat(codex): materialize sanitized codex state`

## Research Gate

Use `smol-toml` for TOML parsing and serialization. Current npm metadata shows a recent typed package with no runtime dependencies and TOML 1.0-oriented behavior; older `toml` and `@iarna/toml` packages are materially stale. Codex auth/config behavior is grounded in the parent design's recorded Codex source references.

## Verification

- `npm test -- src/codexHome.test.ts src/codexAuth.test.ts src/codexConfigPolicy.test.ts src/codexProjectOverlay.test.ts src/codexState.test.ts`
- `npm test -- src/credentials.test.ts src/sessionCredsWriter.test.ts src/git.test.ts`
- `npm run typecheck`

## Implementation Tasks

1. Add `codexHome.ts` and tests for `$CODEX_HOME`, default `~/.codex`, absolute host-home recording, and protected workspace rejection.
2. Add `codexAuth.ts` and tests for file-auth sanitization, refresh buffers, managed-requirements checks, selected fatality, advisory omission, and `0600` writes.
3. Split Claude selected and advisory credential materialization in `credentials.ts` while keeping stripped credential writes centralized.
4. Add `codexConfigPolicy.ts` and fixtures for TOML config rewriting, hooks JSON filtering, automation/credential-routing stripping, MCP/plugin/rule omission, and managed hook source rejection.
5. Add `codexProjectOverlay.ts` and tests for the explicit Codex project overlay allowlist and unsafe file rejection.
6. Add `codexState.ts` and tests for session-local Codex home/auth/session directory materialization with structured warnings and no runtime side effects.
7. Extend `dirtyTree()` exclusions and tests for Codex guidance/config surfaces while preserving unrelated dirty detection.
8. Update docs and `CLAUDE.md`, advance the recipe to Chunk 5, then run final verification and commit.
