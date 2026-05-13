# Codex Agent Support Implementation Recipe

**Parent plan:** `docs/plans/2026-05-13-codex-agent-support.md`
**Current chunk:** Chunk 5

Use this recipe for each implementation iteration. At the end of every iteration, update **Current chunk** to the next chunk number before committing, so the next session can continue without rediscovering state.

## Iteration Workflow

1. **Write the detailed chunk plan**

   Use `writing-plans-v2` to write or expand the detailed implementation plan for the current chunk only. The detailed plan must include exact files, exact tests, exact code shape where useful, verification commands, docs updates, and the intended commit message.

2. **Create skeleton and complete tests**

   Spawn an implementation agent for the current chunk with ownership of:
   - test files for the chunk;
   - skeleton production files needed for the tests to typecheck.

   The agent must fully implement the tests and create only enough production skeleton for the codebase to have no type errors. Skeleton code may throw or return placeholder values only where tests are expected to fail at runtime. The agent must run typecheck and report changed files.

3. **Implement production code without touching tests**

   Spawn a second implementation agent with ownership of production files only. This agent must replace the skeleton with real implementation and cannot edit, rewrite, delete, or relax tests.

   The agent must run the chunk verification commands from the detailed plan and confirm the tests pass. If tests fail because the tests are wrong, the agent must stop and report the specific mismatch instead of editing tests.

4. **Review the completed chunk**

   Spawn a review agent to inspect the full chunk diff for correctness, scope, test quality, docs alignment, and regressions. The review agent must report findings first, with file and line references where applicable.

   If the review finds real issues, fix them in the orchestrator or dispatch a narrowly scoped follow-up agent. Do not silently defer known issues.

5. **Commit and advance the recipe**

   The orchestrator performs the final verification, stages the chunk changes, updates this recipe’s **Current chunk** to the next chunk number, and commits.

   Use the commit message from the detailed chunk plan unless the final diff clearly requires a more accurate message. Do not add `Co-Authored-By` tags.

## Orchestrator Rules

- Keep each iteration scoped to one chunk.
- Do not allow the production implementation agent to modify tests.
- Do not enable Codex runtime launch before Chunk 6.
- Keep Claude as the default behavior throughout the migration.
- Update relevant docs in the same chunk as behavior changes.
- If the first implementation attempt fails, stop guessing and research the documented/source-backed answer before trying a second approach.
