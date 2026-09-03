import type { Event, MemoryTier, TaskStatus, TurnKind, TurnStatus } from "../ledger/schema";
import type { TransitionCause } from "../ledger/tasks-types";
import type { TurnKind as BrokerTurnKind } from "../policy/broker";

type AuditPayloads = {
  event_received: { eventId: string; kind: Event["kind"] };
  turn_started: { turnId: string; kind: TurnKind };
  turn_ended: { turnId: string; status: TurnStatus; spendAmount: number };
  task_created: { taskId: string; title: string };
  task_transitioned: {
    taskId: string;
    from: TaskStatus;
    to: TaskStatus;
    cause: TransitionCause["type"];
  };
  tool_invoked: { tool: string; turnKind: BrokerTurnKind; decision: string };
  confirmation_requested: { taskId: string; actionRef: string };
  confirmation_resolved: {
    taskId: string;
    actionRef: string;
    approved: boolean;
    principalId: string;
  };
  memory_written: { memoryId: string };
  memory_retracted: { memoryId: string; supersededBy: string | null };
  memory_tier_changed: { memoryId: string; tier: MemoryTier };
};

export type AuditEntry = {
  [K in keyof AuditPayloads]: { kind: K; payload: AuditPayloads[K] };
}[keyof AuditPayloads];
