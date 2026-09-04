import type { Clock } from "./ledger/clock";
import type { Ledger } from "./ledger/db";
import type { AgentEvent, AppServerSession, DynamicTool } from "@bevyl-ai/agent-tools";
import type { WebClient } from "@slack/web-api";
import type { Policy } from "./policy/schema";
import type { Logger } from "./log";

export interface ServiceDeps {
  db: Ledger;
  clock: Clock;
  policy: Policy;
  web: WebClient;
  nameOf: (principalId: string) => string | null;
  botPrincipalId: string;
  cwd: string;
  tools: DynamicTool[];
  sessionFactory: (
    tools: DynamicTool[],
    onEvent?: (agentEvent: AgentEvent) => void,
    overrides?: {
      model?: string | undefined;
      effort?: string | undefined;
      turnTimeoutMs?: number | undefined;
    },
  ) => AppServerSession;
  logger: Logger;
}
