/**
 * Pre-split for `--` passthrough. Commander's default handling of `--`
 * appends the tail to the action's positional `args`, which trips the
 * unknown-positional guard in cli.ts. We split host-side before commander
 * parses, then hand commander the head and stash the tail for the launch
 * action to read.
 *
 * Lives in its own module so the unit test doesn't import cli.ts (whose
 * top-level `main()` call would run the CLI on import).
 */

const SUBCOMMANDS = new Set([
  "list",
  "recover",
  "discard",
  "doctor",
  "inspect",
  "init",
  "attach",
  "exec",
  "install-completion",
  "uninstall-completion",
  "completion-server",
]);

const ROOT_OPTIONS_WITH_VALUE = new Set([
  "--config",
  "--profile",
  "--agent",
  "--repo",
  "--extra-repo",
  "--ro",
  "--cp",
  "--sync",
  "--mount",
  "--base",
  "--dockerfile",
  "--docker-build-arg",
  "--print",
  "--name",
  "--hook-enable",
  "--mcp-enable",
  "--docker-run-arg",
  "--refresh-below-ttl",
  "--resume",
  "-p",
  "-n",
  "-r",
]);

function firstRootPositional(tokens: string[]): string | undefined {
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (!tok.startsWith("-")) return tok;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      const optionName = eq >= 0 ? tok.slice(0, eq) : tok;
      if (eq < 0 && ROOT_OPTIONS_WITH_VALUE.has(optionName)) i += 1;
      continue;
    }
    if (ROOT_OPTIONS_WITH_VALUE.has(tok)) i += 1;
  }
  return undefined;
}

export function splitSelectedAgentArgs(argv: string[]): { argvForCommander: string[]; cliSelectedAgentArgs: string[] } {
  const sep = argv.indexOf("--", 2);
  if (sep < 0) return { argvForCommander: argv, cliSelectedAgentArgs: [] };
  const before = argv.slice(2, sep);
  const firstPositional = firstRootPositional(before);
  // tabtab's generated zsh/bash/fish completer invokes
  // `ccairgap completion-server -- "${words[@]}"`. The callback reads
  // COMP_LINE/COMP_CWORD/COMP_POINT from env, not argv, so drop the tail
  // silently instead of erroring — erroring here kills tab-completion.
  if (firstPositional === "completion-server") {
    return { argvForCommander: argv.slice(0, sep), cliSelectedAgentArgs: [] };
  }
  if (firstPositional === "attach") {
    return {
      argvForCommander: argv.slice(0, sep),
      cliSelectedAgentArgs: argv.slice(sep + 1),
    };
  }
  if (firstPositional === "exec") {
    return {
      argvForCommander: argv.slice(0, sep),
      cliSelectedAgentArgs: argv.slice(sep + 1),
    };
  }
  if (firstPositional && SUBCOMMANDS.has(firstPositional)) {
    console.error(
      `ccairgap: -- passthrough is only valid on the default launch command, not on subcommand '${firstPositional}'`,
    );
    process.exit(1);
  }
  return {
    argvForCommander: argv.slice(0, sep),
    cliSelectedAgentArgs: argv.slice(sep + 1),
  };
}

export function splitClaudeArgs(argv: string[]): { argvForCommander: string[]; cliClaudeArgs: string[] } {
  const { argvForCommander, cliSelectedAgentArgs } = splitSelectedAgentArgs(argv);
  return { argvForCommander, cliClaudeArgs: cliSelectedAgentArgs };
}
