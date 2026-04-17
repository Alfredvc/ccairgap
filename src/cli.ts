import { Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cliVersion } from "./version.js";
import { launch } from "./launch.js";
import { doctor, discard, listOrphans, recover } from "./subcommands.js";

function parseBuildArg(v: string, acc: Record<string, string>): Record<string, string> {
  const eq = v.indexOf("=");
  if (eq < 0) throw new Error(`invalid --docker-build-arg: ${v} (expected KEY=VAL)`);
  const key = v.slice(0, eq);
  const val = v.slice(eq + 1);
  acc[key] = val;
  return acc;
}

function isGitRepo(p: string): boolean {
  try {
    const dotGit = resolve(p, ".git");
    return existsSync(dotGit);
  } catch {
    return false;
  }
}

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

async function main() {
  const program = new Command();

  program
    .name("claude-airlock")
    .description("Run Claude Code with --dangerously-skip-permissions in a Docker container.")
    .version(cliVersion(), "-v, --version");

  program
    .option("--repo <path>", "host repo to expose (cloned --shared). Repeatable.", collect, [])
    .option("--ro <path>", "additional read-only bind mount. Repeatable.", collect, [])
    .option("--base <ref>", "base ref for sandbox/<ts> branch (default: HEAD)")
    .option("--keep-container", "do not pass --rm to docker run", false)
    .option("--dockerfile <path>", "use a custom Dockerfile")
    .option(
      "--docker-build-arg <KEY=VAL>",
      "forward build-arg to docker build. Repeatable.",
      parseBuildArg,
      {} as Record<string, string>,
    )
    .option("--rebuild", "force image rebuild before launch", false)
    .option(
      "-p, --print <prompt>",
      "run claude in non-interactive print mode: `claude -p \"<prompt>\"` (no REPL)",
    )
    .action(async (opts) => {
      const repos: string[] = opts.repo;
      const ros: string[] = opts.ro;

      // Default --repo to cwd if it is a git repo, otherwise allow ro-only, otherwise error.
      if (repos.length === 0) {
        const cwd = process.cwd();
        if (isGitRepo(cwd)) {
          repos.push(cwd);
        } else if (ros.length === 0) {
          console.error(
            "claude-airlock: not in a git repo and no --repo / --ro passed. " +
              "Pass --repo <path> or cd into a repo.",
          );
          process.exit(1);
        }
      }

      for (const r of repos) {
        if (!existsSync(r) || !statSync(r).isDirectory()) {
          console.error(`claude-airlock: --repo not a directory: ${r}`);
          process.exit(1);
        }
      }
      for (const r of ros) {
        if (!existsSync(r)) {
          console.error(`claude-airlock: --ro path does not exist: ${r}`);
          process.exit(1);
        }
      }

      // CLAUDE_AIRLOCK_CC_VERSION env short-form for CLAUDE_CODE_VERSION build-arg.
      const buildArgs: Record<string, string> = { ...(opts.dockerBuildArg ?? {}) };
      if (
        process.env.CLAUDE_AIRLOCK_CC_VERSION &&
        !buildArgs.CLAUDE_CODE_VERSION
      ) {
        buildArgs.CLAUDE_CODE_VERSION = process.env.CLAUDE_AIRLOCK_CC_VERSION;
      }

      const result = await launch({
        repos,
        ros,
        base: opts.base,
        keepContainer: Boolean(opts.keepContainer),
        dockerfile: opts.dockerfile,
        dockerBuildArgs: buildArgs,
        rebuild: Boolean(opts.rebuild),
        print: opts.print,
      });
      process.exit(result.exitCode);
    });

  program
    .command("list")
    .description("list orphaned sessions")
    .action(async () => {
      await listOrphans();
    });

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

  program
    .command("doctor")
    .description("preflight checks")
    .action(async () => {
      await doctor();
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error(`claude-airlock: ${(e as Error).message}`);
  process.exit(1);
});
