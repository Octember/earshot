import type { Task, TaskStatus } from "./schema";
import type { PendingConfirmation } from "../schemas/tasks-json";

export interface Anchor {
  venueId: string;
  threadRootId: string | null;
}

export function homeAnchor(task: Pick<Task, "homeVenueId" | "homeThreadRootId">): Anchor {
  return { venueId: task.homeVenueId, threadRootId: task.homeThreadRootId };
}

export class IllegalTransitionError extends Error {
  constructor(taskId: string, from: TaskStatus, to: TaskStatus, causeType: string) {
    super(`T-illegal: cannot transition ${taskId} from ${from} to ${to} via ${causeType}`);
    this.name = "IllegalTransitionError";
  }
}

export class RecurrenceRequiresOperatorError extends Error {
  constructor() {
    super("a recurrence may only be set by an operator sponsor (SPEC §6.5)");
    this.name = "RecurrenceRequiresOperatorError";
  }
}

export type TransitionCause =
  | { type: "dispatch"; executionId: string }
  | { type: "yield_human"; nudgeDeadline: string; pendingConfirmation?: PendingConfirmation }
  | { type: "yield_timer"; wakeAt: string }
  | { type: "yield_external" }
  | { type: "yield_open" }
  | { type: "interrupted" }
  | { type: "crash_loop_parked" }
  | { type: "completed"; report: string }
  | { type: "failed"; report: string }
  | { type: "cancelled"; report: string }
  | { type: "paused" }
  | { type: "nudge_sent"; parkDeadline: string }
  | { type: "park_timeout" }
  | { type: "revive"; pendingConfirmation?: PendingConfirmation | null }
  | { type: "recurrence_rearm"; wakeAt: string }
  | { type: "recurrence_failed"; wakeAt: string };
