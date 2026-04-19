### Task 10: Manual end-to-end verification

**Depends on:** Tasks 1-9
**Commit:** n/a
**Files:** none (verification only)

#### Steps

- [ ] **Step 1: Build the bundle**

Run: `cd /Users/alfredvc/src/ccairgap && npm run build`

Expected: `dist/cli.js` regenerated, no errors.

- [ ] **Step 2: Reproduce original bug (should now succeed with a warning)**

Precondition: user's `~/.claude/settings.json` has an `extraKnownMarketplaces` entry whose `source.path` resolves to `/Users/alfredvc/src/agentfiles`. Verify:

```bash
jq -r '.extraKnownMarketplaces // {} | to_entries[] | select(.value.source.source == "directory" or .value.source.source == "file") | .value.source.path' ~/.claude/settings.json
```

Expected: list includes `/Users/alfredvc/src/agentfiles`.

Then run:

```bash
cd /Users/alfredvc/src/agentfiles
node /Users/alfredvc/src/ccairgap/dist/cli.js --ro ../claude-code
```

Expected on stderr (before the container starts):
```
ccairgap: dropping plugin marketplace mount /Users/alfredvc/src/agentfiles: subsumed by --repo/--extra-repo /Users/alfredvc/src/agentfiles. The container will see the repo's session-clone (committed HEAD) view of this path. Uncommitted changes in /Users/alfredvc/src/agentfiles will not be visible until committed.
```

Docker starts without a "Duplicate mount point" error. Exit with `Ctrl+D`.

- [ ] **Step 3: Verify alternates + session clone disambiguation with same-basename repos (incl. handoff round-trip)**

```bash
mkdir -p /tmp/ccg-test/a/myrepo /tmp/ccg-test/b/myrepo
(cd /tmp/ccg-test/a/myrepo && git init -q && git commit --allow-empty -m init -q)
(cd /tmp/ccg-test/b/myrepo && git init -q && git commit --allow-empty -m init -q)
node /Users/alfredvc/src/ccairgap/dist/cli.js --repo /tmp/ccg-test/a/myrepo --extra-repo /tmp/ccg-test/b/myrepo
```

Expected: container starts. Inside the container:

```
ls /tmp/ccg-test/a/myrepo
ls /tmp/ccg-test/b/myrepo
# Make distinguishable commits in each:
cd /tmp/ccg-test/a/myrepo && echo a > marker-a && git add -A && git commit -qm "from-a"
cd /tmp/ccg-test/b/myrepo && echo b > marker-b && git add -A && git commit -qm "from-b"
exit
```

Expected after exit (handoff round-trip):

```bash
ls ~/.local/state/ccairgap/sessions/*/repos/ 2>/dev/null || echo "session cleaned up"
git -C /tmp/ccg-test/a/myrepo branch | grep ccairgap
git -C /tmp/ccg-test/b/myrepo branch | grep ccairgap
git -C /tmp/ccg-test/a/myrepo show ccairgap/*:marker-a
git -C /tmp/ccg-test/b/myrepo show ccairgap/*:marker-b
```

Expected: each repo has a `ccairgap/<ts>` branch with ONLY its own marker file — proving handoff correctly rehydrated each repo from its disambiguated session clone directory. If `marker-a` appears in repo `b` or vice versa, the handoff/orphans propagation (Task 6 Steps 8-10) is broken.

Cleanup: `rm -rf /tmp/ccg-test`.

- [ ] **Step 4: Verify symlink bypass is now caught**

```bash
ln -sfn /Users/alfredvc/src/ccairgap /tmp/ccg-symlink
node /Users/alfredvc/src/ccairgap/dist/cli.js --repo /Users/alfredvc/src/ccairgap --ro /tmp/ccg-symlink
```

Expected stderr:
```
ccairgap: path appears in both repo (--repo/--extra-repo) and --ro: /tmp/ccg-symlink (resolves to /Users/alfredvc/src/ccairgap)
```

Exit code: 1. Cleanup: `rm /tmp/ccg-symlink`.

- [ ] **Step 5: Verify reserved-dst guard**

```bash
node /Users/alfredvc/src/ccairgap/dist/cli.js --ro /output
```

Expected stderr:
```
ccairgap: /output is a reserved container path; --ro /output cannot use it
```

Exit code: 1.

- [ ] **Step 6: Verify ENOENT UX preserved**

```bash
node /Users/alfredvc/src/ccairgap/dist/cli.js --repo /definitely/does/not/exist
```

Expected stderr:
```
ccairgap: --repo/--extra-repo path does not exist: /definitely/does/not/exist
```

Exit code: 1. No TypeScript/Node stack trace.

- [ ] **Step 7: Record results**

If any step fails, file a note against the relevant task and fix before moving on.

---

