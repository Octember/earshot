import type { Database } from "bun:sqlite";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { Clock } from "../ledger/clock";
import type { IdentityConfig } from "../policy/schema";
import type { TurnEffect } from "../schemas/effects";
import type { WakePostContext } from "../service-wake-post";

export interface TurnContext {
  db: Database;
  clock: Clock;
  identity: IdentityConfig;
  external: DynamicTool[];
  effects: TurnEffect[];
}

export interface ResidentContext extends TurnContext {
  post: WakePostContext | null;
}

export interface ExecutionContext extends TurnContext {
  taskId: string;
  parkAfterMs: number;
}
