import type { Database } from "bun:sqlite";
import type { Clock } from "./ledger/clock";
import type { AgentEvent, AppServerSession, DynamicTool } from "@bevyl-ai/agent-tools";
import type { WebClient } from "@slack/web-api";
import type { PolicyStore } from "./policy/load";
import type { Logger } from "./log";

export interface ServiceDeps {
  db: Database;
  clock: Clock;
  policyStore: PolicyStore;
  web: WebClient;
  nameOf: (principalId: string) => string | null;
  botPrincipalId: string;
  cwd: string;

  sessionFactory: (
    tools: DynamicTool[],
    onEvent?: (agentEvent: AgentEvent) => void,
    overrides?: { model?: string; effort?: string },
  ) => AppServerSession;
  newId: () => string;
  tools: DynamicTool[];
  logger: Logger;
  heartbeatMs: number;
}
