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
  cwd: string; // workspace directory for codex sessions
  // Attention-pass workspace (its AGENTS.md); defaults to `${cwd}-ear`.
  earCwd?: string;
  sessionFactory: (
    tools: DynamicTool[],
    onEvent?: (agentEvent: AgentEvent) => void,
    overrides?: { model?: string; effort?: string },
  ) => AppServerSession;
  newId: () => string; // unique ids for events / executions / turns
  catalog?: ToolCatalog; // external tool implementations (empty for the built-in-only default)
  registries?: ToolRegistry[];
  logger?: Logger;
  heartbeatMs?: number; // if set, start() runs a real interval; omit to drive tick() manually
}
