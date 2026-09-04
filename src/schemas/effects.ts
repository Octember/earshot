import type { Anchor } from "../ledger/tasks-types";

export type TurnEffect =
  | { kind: "posted"; anchor: Anchor; text: string }
  | { kind: "reacted"; emoji: string; venueId: string; ts: string }
  | { kind: "stepped_back"; venueId: string; threadRootId: string; why: string }
  | {
      kind: "ear_verdict";
      decision: "hold" | "wake";
      why: string;
      venueId: string;
      threadRootId: string;
    }
  | { kind: "task_created"; taskId: string }
  | { kind: "task_cancelled"; taskId: string; applied: boolean }
  | { kind: "task_steered"; taskId: string; applied: boolean }
  | { kind: "task_completed"; taskId: string }
  | { kind: "task_failed"; taskId: string }
  | { kind: "task_asked"; taskId: string; question: string }
  | { kind: "yielded_timer"; taskId: string; wakeAt: string };
