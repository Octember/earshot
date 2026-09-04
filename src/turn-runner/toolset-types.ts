import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { Clock } from "../ledger/clock";
import type { Ledger } from "../ledger/db";
import type { IdentityConfig } from "../policy/schema";
import type { WakePostContext } from "../service-wake-post";

export interface TurnContext {
  db: Ledger;
  clock: Clock;
  identity: IdentityConfig;
  external: DynamicTool[];
}

export interface ResidentContext extends TurnContext {
  post: WakePostContext | null;
}

export interface ExecutionContext extends TurnContext {
  taskId: string;
  parkAfterMs: number;
}
