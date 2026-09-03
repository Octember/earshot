import type { Database } from "bun:sqlite";
import type { Clock } from "./ledger/clock";
import type {
  AgentEvent,
  AppServerSession,
  DynamicTool,
  SlackAdapter,
} from "@bevyl-ai/agent-tools";
import type { PolicyStore } from "./policy/load";
import type { ToolCatalog } from "./policy/broker";
import type { ToolRegistry } from "./tools/catalog-types";
import type { Logger } from "./log";

export interface ServiceDeps {
  db: Database;
  clock: Clock;
  policyStore: PolicyStore;
  adapter: SlackAdapter;
  botPrincipalId: string;
  cwd: string;

  earCwd?: string;
  sessionFactory: (
    tools: DynamicTool[],
    onEvent?: (agentEvent: AgentEvent) => void,
    overrides?: { model?: string; effort?: string },
  ) => AppServerSession;
  newId: () => string;
  catalog?: ToolCatalog;
  registries?: ToolRegistry[];
  logger?: Logger;
  heartbeatMs?: number;
}
