import type { AgentKind, AgentMode } from "./agent.js";

const validatedArgvBrand: unique symbol = Symbol("ccairgap.validatedAgentArgv");

export type ValidatedAgentArgv = string[] & {
  readonly [validatedArgvBrand]: true;
};

export interface AgentCommandPlan {
  agent: AgentKind;
  env: Record<string, string>;
  argv: string[];
}

export function validatedAgentArgv(argv: readonly string[]): ValidatedAgentArgv {
  const branded = [...argv] as ValidatedAgentArgv;
  Object.defineProperty(branded, validatedArgvBrand, {
    value: true,
  });
  return branded;
}

export function agentCommandPlan(mode: AgentMode, argv: ValidatedAgentArgv): AgentCommandPlan {
  assertValidatedAgentArgv(argv);

  const env: Record<string, string> = {
    CCAIRGAP_AGENT: mode.agent,
  };
  if (mode.print !== undefined) {
    env.CCAIRGAP_PRINT = mode.print;
  }

  return {
    agent: mode.agent,
    env,
    argv: [...argv],
  };
}

function assertValidatedAgentArgv(argv: ValidatedAgentArgv): void {
  if (argv[validatedArgvBrand] !== true) {
    throw new Error("agent argv must come from validatedAgentArgv");
  }
}
