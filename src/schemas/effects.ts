import type { Anchor } from "../ledger/tasks-types";
import type { MemoryTier, SteeringKind } from "../ledger/schema";
import type { ActionClass } from "../policy/broker";

export type TurnEffect =
  | { kind: "posted"; anchor: Anchor; text: string }
  | { kind: "withheld"; anchor: Anchor; text: string }
  | { kind: "reacted"; emoji: string; venueId: string; ts?: string | undefined }
  | { kind: "stepped_back"; venueId: string; threadRootId: string | null; why: string }
  | {
      kind: "ear_verdict";
      decision: string;
      why: string;
      venueId: string | undefined;
      threadRootId: string | null;
    }
  | { kind: "confirmation_requested"; tool: string; actionClasses: ActionClass[] }
  | { kind: "confirmation_resolved"; taskId: string; approve: boolean; applied: boolean }
  | { kind: "task_created"; taskId: string }
  | { kind: "task_cancelled"; taskId: string; applied: boolean }
  | { kind: "task_steered"; taskId: string; steerKind: SteeringKind; applied: boolean }
  | { kind: "task_completed"; taskId: string }
  | { kind: "task_failed"; taskId: string }
  | { kind: "task_asked"; taskId: string; question: string }
  | { kind: "yielded_timer"; taskId: string | undefined; wakeAt: string }
  | { kind: "memory_written"; memoryId: string }
  | { kind: "memory_retracted"; memoryId: string }
  | { kind: "memory_tiered"; memoryId: string; tier: MemoryTier };
