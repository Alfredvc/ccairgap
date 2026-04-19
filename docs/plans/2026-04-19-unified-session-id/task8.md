### Task 8: Final verification

**Depends on:** Task 7
**Commit:** none
**Files:**
- None (verification only).

#### Steps:

- [ ] **Step 1: Full test suite**

Run: `npm test`
Expected: all tests pass. `sessionId.test.ts` should show 8 tests.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: clean tsup bundle.

- [ ] **Step 4: Dry-run smoke test (manual)**

Run: `./dist/cli.js doctor`
Expected: all checks pass.

Optional (if docker + a test repo available):
- `cd <some-git-repo>` and run `./dist/cli.js -p "echo hello"` — session id should print as part of any "recover manually" hint; `ccairgap list` run during/after should show the id in `<prefix>-<4hex>` form.

- [ ] **Step 5: No stray `<ts>` sweep**

Run: `grep -rn "<ts>" docs/SPEC.md README.md CLAUDE.md SECURITY.md skills/`
Expected: zero output (`docs/research/` excluded — historical).

Run: `grep -rn "compactTimestamp\|ts:\s*string\|\bo\.ts\b\|result\.ts\b" src/`
Expected: no matches.
