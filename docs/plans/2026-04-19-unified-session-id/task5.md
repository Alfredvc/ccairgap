### Task 5: Rename `ts` → `id` in `subcommands.ts` + `cli.ts`

**Depends on:** Task 4
**Commit:** implementer
**Files:**
- Modify: `/Users/alfredvc/src/ccairgap/src/subcommands.ts`
- Modify: `/Users/alfredvc/src/ccairgap/src/cli.ts`

Finishes the rename. `cli.ts` also gets the updated `--name` help text and the renamed positional args on the `recover`/`discard` commands.

#### Steps:

- [ ] **Step 1: Edit `src/subcommands.ts`**

Find:

```typescript
  for (const o of orphans) {
    const commits = Object.entries(o.commits)
      .map(([k, v]) => `${k}+${v}`)
      .join(" ");
    console.log(`${o.ts}  repos=${o.repos.join(",") || "(none)"}  ${commits}`);
  }
```

Replace with:

```typescript
  for (const o of orphans) {
    const commits = Object.entries(o.commits)
      .map(([k, v]) => `${k}+${v}`)
      .join(" ");
    console.log(`${o.id}  repos=${o.repos.join(",") || "(none)"}  ${commits}`);
  }
```

Find:

```typescript
export async function recover(ts?: string): Promise<void> {
  if (!ts) return listOrphans();
  const sd = sessionDirFn(ts);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  const result = await handoff(sd, cliVersion());
  const counts = { fetched: 0, empty: 0, failed: 0 };
  for (const f of result.fetched) counts[f.status]++;
  console.log(
    `recovered ${ts}: ${counts.fetched} fetched, ${counts.empty} empty, ${counts.failed} failed, ` +
      `${result.transcriptsCopied} transcript dirs copied, ` +
      `session dir ${result.removed ? "removed" : result.preserved ? "preserved" : "kept"}`,
  );
  if (result.warnings.length > 0) process.exitCode = 1;
}

export function discard(ts: string): void {
  const sd = sessionDirFn(ts);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  rmSync(sd, { recursive: true, force: true });
  console.log(`discarded ${ts}`);
}
```

Replace with:

```typescript
export async function recover(id?: string): Promise<void> {
  if (!id) return listOrphans();
  const sd = sessionDirFn(id);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  const result = await handoff(sd, cliVersion());
  const counts = { fetched: 0, empty: 0, failed: 0 };
  for (const f of result.fetched) counts[f.status]++;
  console.log(
    `recovered ${id}: ${counts.fetched} fetched, ${counts.empty} empty, ${counts.failed} failed, ` +
      `${result.transcriptsCopied} transcript dirs copied, ` +
      `session dir ${result.removed ? "removed" : result.preserved ? "preserved" : "kept"}`,
  );
  if (result.warnings.length > 0) process.exitCode = 1;
}

export function discard(id: string): void {
  const sd = sessionDirFn(id);
  if (!existsSync(sd)) {
    console.error(`ccairgap: no session dir at ${sd}`);
    process.exit(1);
  }
  rmSync(sd, { recursive: true, force: true });
  console.log(`discarded ${id}`);
}
```

- [ ] **Step 2: Edit `src/cli.ts` — `--name` help text**

Find:

```typescript
    .option(
      "-n, --name <name>",
      "session name. Used as branch suffix (`ccairgap/<name>`) and forwarded to `claude -n \"[ccairgap] <name>\"` so the session shows up with that label in `/resume` and the terminal title. The `[ccairgap]` prefix is always applied. Must be a valid git ref component; aborts on collision with an existing branch in --repo.",
    )
```

Replace with:

```typescript
    .option(
      "-n, --name <name>",
      "session id prefix. Used as-is; the CLI appends a 4-hex suffix so the final id is `<name>-<4hex>`. The id drives the session dir, docker container (`ccairgap-<id>`), branch (`ccairgap/<id>`), and Claude's session label (`[ccairgap] <id>`). If omitted, a random `<adj>-<noun>` prefix is generated. Must be a valid git ref component.",
    )
```

Find:

```typescript
    .option("--base <ref>", "base ref for ccairgap/<ts> branch (default: HEAD)")
```

Replace with:

```typescript
    .option("--base <ref>", "base ref for ccairgap/<id> branch (default: HEAD)")
```

Find:

```typescript
    .option(
      "--sync <path>",
      "like --cp, but on exit the container-written copy is mirrored to $CCAIRGAP_HOME/output/<ts>/<abs-src>/. Repeatable.",
      collect,
      [],
    )
```

Replace with:

```typescript
    .option(
      "--sync <path>",
      "like --cp, but on exit the container-written copy is mirrored to $CCAIRGAP_HOME/output/<id>/<abs-src>/. Repeatable.",
      collect,
      [],
    )
```

- [ ] **Step 3: Edit `src/cli.ts` — `recover` / `discard` subcommands**

Find:

```typescript
  program
    .command("recover [ts]")
    .description("run handoff for a session (idempotent); without <ts>, same as list")
    .action(async (ts?: string) => {
      await recover(ts);
    });

  program
    .command("discard <ts>")
    .description("delete a session dir without running handoff")
    .action((ts: string) => {
      discard(ts);
    });
```

Replace with:

```typescript
  program
    .command("recover [id]")
    .description("run handoff for a session (idempotent); without <id>, same as list")
    .action(async (id?: string) => {
      await recover(id);
    });

  program
    .command("discard <id>")
    .description("delete a session dir without running handoff")
    .action((id: string) => {
      discard(id);
    });
```

- [ ] **Step 4: Typecheck + test**

Run: `npm run typecheck && npm test`
Expected: both pass with zero errors.

- [ ] **Step 5: Commit (covers Tasks 2–5)**

```bash
git add src/launch.ts src/paths.ts src/orphans.ts src/handoff.ts src/subcommands.ts src/cli.ts
git commit -m "refactor: unify session identifier as <prefix>-<4hex>

Replaces the ISO-timestamp ts throughout the launch pipeline, handoff,
recover, discard, list, and orphan scan with a single readable session id
generated from generateId(). --name becomes the prefix; the 4-hex suffix
is always appended. Existing timestamp-named session dirs continue to
work because ids are treated as opaque strings."
```

---

