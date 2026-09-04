import type { Database } from "bun:sqlite";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { Clock } from "../ledger/clock";
import type { IdentityConfig } from "../policy/schema";
import type { TurnEffect } from "../schemas/effects";
import type { WakePostContext } from "../service-wake-post";

export interface ToolsetContext {
  db: Database;
  clock: Clock;
  identity: IdentityConfig;
  turnKind: "resident" | "execution_step";
  external: DynamicTool[];
  taskId?: string | undefined;
  parkAfterMs: number;
  post: WakePostContext | null;
  effects: TurnEffect[];
}
