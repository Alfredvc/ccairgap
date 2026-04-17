import { Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cliVersion } from "./version.js";
import { launch } from "./launch.js";
import { doctor, discard, listOrphans, recover } from "./subcommands.js";
import { loadConfig, resolveConfigPaths, type ConfigFile } from "./config.js";

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

/** Merge CLI > config. Scalars: CLI wins. Arrays concat (config first, then CLI). Maps merge (CLI wins per-key). */
function mergeRun(cli: {
  repo?: string;
  extraRepo: string[];
  ro: string[];
  cp: string[];
  sync: string[];
  mount: string[];
  base?: string;
  keepContainer?: boolean;
  dockerfile?: string;
  dockerBuildArg?: Record<string, string>;
  rebuild?: boolean;
  print?: string;
  name?: string;
}, cfg: ConfigFile) {
  return {
    repo: cli.repo ?? cfg.repo,
    extraRepos: [...(cfg.extraRepo ?? []), ...cli.extraRepo],
    ros: [...(cfg.ro ?? []), ...cli.ro],
    cp: [...(cfg.cp ?? []), ...cli.cp],
    sync: [...(cfg.sync ?? []), ...cli.sync],
    mount: [...(cfg.mount ?? []), ...cli.mount],
    base: cli.base ?? cfg.base,
    keepContainer: cli.keepContainer ?? cfg.keepContainer ?? false,
    dockerfile: cli.dockerfile ?? cfg.dockerfile,
    dockerBuildArgs: { ...(cfg.dockerBuildArg ?? {}), ...(cli.dockerBuildArg ?? {}) },
    rebuild: cli.rebuild ?? cfg.rebuild ?? false,
    print: cli.print ?? cfg.print,
    name: cli.name ?? cfg.name,
  };
}

async function main() {
  const program = new Command();

  program
    .name("claude-airlock")
    .description("Run Claude Code with --dangerously-skip-permissions in a Docker container.")
    .version(cliVersion(), "-v, --version");

  program
    .option("--config <path>", "path to yaml config file (default: <git-root>/.claude-airgap/config.yaml)")
    .option("--repo <path>", "host repo to expose as workspace (cloned --shared). Defaults to cwd if it's a git repo.")
    .option("--extra-repo <path>", "additional host repo exposed alongside --repo (cloned --shared). Repeatable.", collect, [])
    .option("--ro <path>", "additional read-only bind mount. Repeatable.", collect, [])
    .option(
      "--cp <path>",
      "copy host path into session at launch (rw in container, discarded on exit). Relative paths resolve against the workspace repo root. Repeatable.",
      collect,
      [],
    )
    .option(
      "--sync <path>",
      "like --cp, but on exit the container-written copy is mirrored to $CLAUDE_AIRLOCK_HOME/output/<ts>/<abs-src>/. Repeatable.",
      collect,
      [],
    )
    .option(
      "--mount <path>",
      "rw bind-mount host path into container at the same absolute path. Live host writes. Relative paths resolve against the workspace repo root. Repeatable.",
      collect,
      [],
    )
    .option("--base <ref>", "base ref for sandbox/<ts> branch (default: HEAD)")
    .option("--keep-container", "do not pass --rm to docker run")
    .option("--dockerfile <path>", "use a custom Dockerfile")
    .option(
      "--docker-build-arg <KEY=VAL>",
      "forward build-arg to docker build. Repeatable.",
      parseBuildArg,
      {} as Record<string, string>,
    )
    .option("--rebuild", "force image rebuild before launch")
    .option(
      "-p, --print <prompt>",
      "run claude in non-interactive print mode: `claude -p \"<prompt>\"` (no REPL)",
    )
    .option(
      "-n, --name <name>",
      "session name. Used as branch suffix (`sandbox/<name>`) and forwarded to `claude -n <name>`. Must be a valid git ref component; aborts on collision with an existing branch in --repo.",
    )
    .action(async (opts) => {
      // Load config file (if any). Paths inside config resolve relative to config file dir.
      let fileCfg: ConfigFile = {};
      const loaded = loadConfig(opts.config);
      if (loaded.path) {
        fileCfg = resolveConfigPaths(loaded.config, loaded.path);
      }

      // dockerBuildArg only counts as "set via CLI" if non-empty (commander default is {}).
      const cliBuildArg: Record<string, string> | undefined =
        opts.dockerBuildArg && Object.keys(opts.dockerBuildArg).length > 0
          ? opts.dockerBuildArg
          : undefined;

      const merged = mergeRun(
        {
          repo: opts.repo as string | undefined,
          extraRepo: opts.extraRepo as string[],
          ro: opts.ro as string[],
          cp: opts.cp as string[],
          sync: opts.sync as string[],
          mount: opts.mount as string[],
          base: opts.base,
          keepContainer: opts.keepContainer,
          dockerfile: opts.dockerfile,
          dockerBuildArg: cliBuildArg,
          rebuild: opts.rebuild,
          print: opts.print,
          name: opts.name,
        },
        fileCfg,
      );

      let workspaceRepo = merged.repo;
      const extraRepos = merged.extraRepos;
      const ros = merged.ros;

      // Default --repo to cwd if it is a git repo, otherwise allow ro-only, otherwise error.
      if (!workspaceRepo) {
        const cwd = process.cwd();
        if (isGitRepo(cwd)) {
          workspaceRepo = cwd;
        } else if (extraRepos.length > 0) {
          console.error(
            "claude-airlock: --extra-repo requires --repo <path> (workspace). " +
              "Pass --repo <path> or cd into a repo.",
          );
          process.exit(1);
        } else if (ros.length === 0) {
          console.error(
            "claude-airlock: not in a git repo and no --repo / --ro passed. " +
              "Pass --repo <path> or cd into a repo.",
          );
          process.exit(1);
        }
      }

      const repos: string[] = workspaceRepo ? [workspaceRepo, ...extraRepos] : [...extraRepos];

      for (const r of repos) {
        if (!existsSync(r) || !statSync(r).isDirectory()) {
          console.error(`claude-airlock: repo path not a directory: ${r}`);
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
      const buildArgs: Record<string, string> = { ...merged.dockerBuildArgs };
      if (
        process.env.CLAUDE_AIRLOCK_CC_VERSION &&
        !buildArgs.CLAUDE_CODE_VERSION
      ) {
        buildArgs.CLAUDE_CODE_VERSION = process.env.CLAUDE_AIRLOCK_CC_VERSION;
      }

      const result = await launch({
        repos,
        ros,
        cp: merged.cp,
        sync: merged.sync,
        mount: merged.mount,
        base: merged.base,
        keepContainer: merged.keepContainer,
        dockerfile: merged.dockerfile,
        dockerBuildArgs: buildArgs,
        rebuild: merged.rebuild,
        print: merged.print,
        name: merged.name,
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
