import type { Database } from "bun:sqlite";
import type { Clock } from "./ledger/clock";
import type { Anchor } from "./ledger/tasks";
import type { InboxMessage } from "./ledger/inbox";
import type {
  AgentEvent,
  AppServerSession,
  DynamicTool,
  SlackAdapter,
} from "@bevyl-ai/agent-tools";
import type { PolicyStore } from "./policy/load";
import type { Policy, IdentityConfig } from "./policy/schema";
import type { ToolCatalog } from "./policy/broker";
import type { ToolRegistry } from "./tools/catalog";
import type { Logger } from "./log";

export function isDirectAddress(message: InboxMessage): boolean {
  return message.addressMode === "mention" || message.addressMode === "dm";
}

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

export type ServiceHost = {
  d: ServiceDeps;
  log: Logger;
  catalog: ToolCatalog;
  residentDebounce: Map<string, ReturnType<typeof setTimeout>>;
  residentRunning: Set<string>;
  residentRerun: Set<string>;
  earDebounce: Map<string, ReturnType<typeof setTimeout>>;
  earRunning: Set<string>;
  earRerun: Set<string>;
  distillRunning: Set<string>;
  wakes: Set<Promise<unknown>>;
  stopping: boolean;
  postMessage: (anchor: Anchor, text: string) => Promise<{ messageId: string }>;
  workspaceFor: (identityId: string) => string;
  identityById: (id: string) => IdentityConfig | undefined;
  principalOf: (id: string | null) => { id: string; isOperator: boolean };
  track: (set: Set<Promise<unknown>>, promise: Promise<unknown>) => void;
  policy: () => Policy;
  refreshSoul: () => void;
  maybeTick: () => void;
};
