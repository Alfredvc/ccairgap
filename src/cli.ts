import { Command } from "commander";
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { cliVersion } from "./version.js";
import { launch } from "./launch.js";
import { doctor, discard, initCmd, inspectCmd, listOrphans, recover } from "./subcommands.js";
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
  hookEnable: string[];
  mcpEnable: string[];
  dockerRunArg: string[];
  warnDockerArgs?: boolean;
  clipboard?: boolean;
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
    hookEnable: [...(cfg.hooks?.enable ?? []), ...cli.hookEnable],
    mcpEnable: [...(cfg.mcp?.enable ?? []), ...cli.mcpEnable],
    dockerRunArg: [...(cfg.dockerRunArg ?? []), ...cli.dockerRunArg],
    warnDockerArgs: cli.warnDockerArgs ?? cfg.warnDockerArgs ?? true,
    clipboard: cli.clipboard ?? cfg.clipboard ?? true,
  };
}

async function main() {
  const program = new Command();

  program
    .name("ccairgap")
    .description("Run Claude Code with --dangerously-skip-permissions in a Docker container.")
    .version(cliVersion(), "-v, --version");

  // Reject unknown positionals on the root command (e.g. `ccairgap lsit`).
  // Commander's unknownCommand path is gated on the root having no .action(), so
  // without this hook typos fall through to the launch flow as ignored excess args.
  program.hook("preAction", (thisCommand, actionCommand) => {
    if (actionCommand !== thisCommand) return;
    const first = thisCommand.args[0];
    if (first !== undefined) program.error(`unknown command '${first}'`);
  });

  program
    .option(
      "--config <path>",
      "path to yaml config file (default: <git-root>/.ccairgap/config.yaml, " +
        "fallback: <git-root>/.config/ccairgap/config.yaml). " +
        "Inside the config, relative `repo`/`extra-repo`/`ro` paths anchor on the git " +
        "root (parent of the config dir); relative `dockerfile` anchors on the config " +
        "file's directory; relative `cp`/`sync`/`mount` anchor on the workspace repo root.",
    )
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
      "like --cp, but on exit the container-written copy is mirrored to $CCAIRGAP_HOME/output/<id>/<abs-src>/. Repeatable.",
      collect,
      [],
    )
    .option(
      "--mount <path>",
      "rw bind-mount host path into container at the same absolute path. Live host writes. Relative paths resolve against the workspace repo root. Repeatable.",
      collect,
      [],
    )
    .option("--base <ref>", "base ref for ccairgap/<id> branch (default: HEAD)")
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
      "session id prefix. Used as-is; the CLI appends a 4-hex suffix so the final id is `<name>-<4hex>`. The id drives the session dir, docker container (`ccairgap-<id>`), branch (`ccairgap/<id>`), and Claude's session label (`[ccairgap] <id>`). If omitted, a random `<adj>-<noun>` prefix is generated. Must be a valid git ref component.",
    )
    .option(
      "--hook-enable <glob>",
      "enable a Claude Code hook whose `command` matches <glob>. All hooks are disabled by default inside the sandbox; each --hook-enable opts a hook back in. Glob wildcard is `*`. Repeatable.",
      collect,
      [],
    )
    .option(
      "--mcp-enable <glob>",
      "enable a Claude Code MCP server whose `name` (key under `mcpServers`) matches <glob>. All MCP servers are disabled by default inside the sandbox; each --mcp-enable opts one back in. Project-scope `<repo>/.mcp.json` servers additionally require host approval (the approval dialog is unreachable inside the airgap). Glob wildcard is `*`. Repeatable.",
      collect,
      [],
    )
    .option(
      "--docker-run-arg <args>",
      "extra args appended to `docker run`. Shell-quoted value (e.g. --docker-run-arg '-p 8080:8080'). Last-wins on conflicts with built-in args. Repeatable.",
      collect,
      [],
    )
    .option("--no-warn-docker-args", "suppress the dangerous-arg warning for --docker-run-arg")
    .option("--no-clipboard", "disable image-clipboard passthrough (host-side watcher + bridge-dir RO mount). Passthrough is enabled by default on supported hosts (macOS with pngpaste; Linux Wayland/X11 with wl-clipboard/xclip; WSL2 with wl-clipboard). No-op under --print.")
    .option(
      "--bare",
      "launch a naked container: skip config-file loading and cwd-as-workspace inference. " +
        "The user must mount any repo via --repo (or reference material via --ro). Claude config " +
        "(~/.claude, credentials, plugins) flows as usual. Relative --cp/--sync/--mount paths " +
        "anchor on cwd. --config still loads when explicit.",
    )
    .action(async (opts, cmd) => {
      const bare = Boolean(opts.bare);

      // Load config file (if any). Paths inside config resolve relative to config file dir.
      // Under --bare, skip the default-path walk entirely — only an explicit --config loads.
      let fileCfg: ConfigFile = {};
      if (!bare || opts.config) {
        const loaded = loadConfig(opts.config);
        if (loaded.path) {
          fileCfg = resolveConfigPaths(loaded.config, loaded.path);
        }
      }

      // dockerBuildArg only counts as "set via CLI" if non-empty (commander default is {}).
      const cliBuildArg: Record<string, string> | undefined =
        opts.dockerBuildArg && Object.keys(opts.dockerBuildArg).length > 0
          ? opts.dockerBuildArg
          : undefined;

      // warnDockerArgs default is `true`; only treat as "set via CLI" when the
      // user actually passed --no-warn-docker-args (or --warn-docker-args).
      const warnDockerArgsSource = cmd.getOptionValueSource("warnDockerArgs");
      const cliWarnDockerArgs: boolean | undefined =
        warnDockerArgsSource === "cli" ? (opts.warnDockerArgs as boolean) : undefined;

      const clipboardSource = cmd.getOptionValueSource("clipboard");
      const cliClipboard: boolean | undefined =
        clipboardSource === "cli" ? (opts.clipboard as boolean) : undefined;

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
          hookEnable: opts.hookEnable as string[],
          mcpEnable: opts.mcpEnable as string[],
          dockerRunArg: opts.dockerRunArg as string[],
          warnDockerArgs: cliWarnDockerArgs,
          clipboard: cliClipboard,
        },
        fileCfg,
      );

      let workspaceRepo = merged.repo;
      const extraRepos = merged.extraRepos;
      const ros = merged.ros;

      // Default --repo to cwd if it is a git repo, otherwise allow ro-only, otherwise error.
      // Under --bare: skip all inference; still reject --extra-repo without --repo so the
      // workspace contract stays explicit.
      if (bare) {
        if (!workspaceRepo && extraRepos.length > 0) {
          console.error(
            "ccairgap: --extra-repo requires --repo <path> (workspace). " +
              "Pass --repo <path>.",
          );
          process.exit(1);
        }
      } else if (!workspaceRepo) {
        const cwd = process.cwd();
        if (isGitRepo(cwd)) {
          workspaceRepo = cwd;
        } else if (extraRepos.length > 0) {
          console.error(
            "ccairgap: --extra-repo requires --repo <path> (workspace). " +
              "Pass --repo <path> or cd into a repo.",
          );
          process.exit(1);
        } else if (ros.length === 0) {
          console.error(
            "ccairgap: not in a git repo and no --repo / --ro passed. " +
              "Pass --repo <path> or cd into a repo.",
          );
          process.exit(1);
        }
      }

      const repos: string[] = workspaceRepo ? [workspaceRepo, ...extraRepos] : [...extraRepos];

      for (const r of repos) {
        if (!existsSync(r) || !statSync(r).isDirectory()) {
          console.error(`ccairgap: repo path not a directory: ${r}`);
          process.exit(1);
        }
      }
      for (const r of ros) {
        if (!existsSync(r)) {
          console.error(`ccairgap: --ro path does not exist: ${r}`);
          process.exit(1);
        }
      }

      // CCAIRGAP_CC_VERSION env short-form for CLAUDE_CODE_VERSION build-arg.
      const buildArgs: Record<string, string> = { ...merged.dockerBuildArgs };
      if (
        process.env.CCAIRGAP_CC_VERSION &&
        !buildArgs.CLAUDE_CODE_VERSION
      ) {
        buildArgs.CLAUDE_CODE_VERSION = process.env.CCAIRGAP_CC_VERSION;
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
        hookEnable: merged.hookEnable,
        mcpEnable: merged.mcpEnable,
        dockerRunArgs: merged.dockerRunArg,
        warnDockerArgs: merged.warnDockerArgs,
        clipboard: merged.clipboard,
        bare,
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

  program
    .command("doctor")
    .description("preflight checks")
    .action(async () => {
      await doctor();
    });

  program
    .command("inspect")
    .description(
      "enumerate the config surfaces the container would see at launch: hook entries " +
        "(user settings, enabled plugins, project .claude/settings.json[.local]) and MCP " +
        "server definitions (~/.claude.json user + user-project, <repo>/.mcp.json, plugin " +
        "dirs). JSON `{hooks, mcpServers}` to stdout. Read-only.",
    )
    .option("--config <path>", "path to yaml config file (same semantics as launch)")
    .option("--repo <path>", "host repo whose .claude/settings.json[.local] and .mcp.json should be included. Defaults to cwd if it's a git repo.")
    .option("--extra-repo <path>", "additional host repo to include. Repeatable.", collect, [])
    .option("--pretty", "render human-readable tables instead of JSON")
    .action((opts) => {
      let fileCfg: ConfigFile = {};
      const loaded = loadConfig(opts.config);
      if (loaded.path) fileCfg = resolveConfigPaths(loaded.config, loaded.path);

      const repo: string | undefined = (opts.repo as string | undefined) ?? fileCfg.repo;
      const extraRepos: string[] = [
        ...(fileCfg.extraRepo ?? []),
        ...((opts.extraRepo as string[]) ?? []),
      ];

      let workspaceRepo = repo;
      if (!workspaceRepo) {
        const cwd = process.cwd();
        if (isGitRepo(cwd)) workspaceRepo = cwd;
      }

      const repos: string[] = workspaceRepo ? [workspaceRepo, ...extraRepos] : [...extraRepos];
      for (const r of repos) {
        if (!existsSync(r) || !statSync(r).isDirectory()) {
          console.error(`ccairgap: repo path not a directory: ${r}`);
          process.exit(1);
        }
      }

      inspectCmd({ repos, pretty: Boolean(opts.pretty) });
    });

  program
    .command("init")
    .description(
      "materialize the bundled Dockerfile, entrypoint.sh, and a minimal " +
        "config.yaml into <git-root>/.ccairgap/ (or <git-root>/.config/ccairgap/ " +
        "when that dir already exists, or dirname(--config) if --config is " +
        "passed). Lets you customize the container image without forking the repo.",
    )
    .option(
      "--config <path>",
      "target a specific config file location instead of the default " +
        "(<git-root>/.ccairgap/config.yaml, or <git-root>/.config/ccairgap/config.yaml " +
        "when that dir already exists)",
    )
    .option(
      "--force",
      "overwrite existing Dockerfile / entrypoint.sh / config.yaml (destructive; no merge)",
    )
    .action((opts) => {
      try {
        initCmd({
          configPath: opts.config,
          force: Boolean(opts.force),
        });
      } catch (e) {
        console.error(`ccairgap: ${(e as Error).message}`);
        process.exit(1);
      }
    });

  await program.parseAsync(process.argv);
}

main().catch((e) => {
  console.error(`ccairgap: ${(e as Error).message}`);
  process.exit(1);
});
