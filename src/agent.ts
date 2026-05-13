export type AgentKind = "claude" | "codex";

export type AgentMode =
  | { agent: "claude"; print?: string; resume?: string }
  | { agent: "codex"; print?: string };

export interface AgentSelection {
  kind: AgentKind;
  mode: AgentMode;
}

export const AGENT_KINDS = ["claude", "codex"] as const satisfies readonly AgentKind[];

export function parseAgentKind(value: unknown, source = "agent"): AgentKind {
  if (value === "claude" || value === "codex") return value;
  throw new Error(
    `${source}: invalid agent '${String(value)}' (allowed: ${AGENT_KINDS.join(", ")})`,
  );
}

export function resolveAgentSelection(opts: {
  configAgent?: AgentKind;
  cliAgent?: AgentKind;
  print?: string;
  resume?: string;
}): AgentSelection {
  const kind = opts.cliAgent ?? opts.configAgent ?? "claude";
  if (kind === "claude") {
    return {
      kind,
      mode: { agent: kind, print: opts.print, resume: opts.resume },
    };
  }
  return {
    kind,
    mode: { agent: kind, print: opts.print },
  };
}

export function assertExhaustiveAgent(value: never): never {
  throw new Error(`Unhandled agent kind: ${String(value)}`);
}
