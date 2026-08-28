import type { TaskStatus, WaitingOn } from "./schema";

export interface Anchor {
  venueId: string;
  threadRootId: string | null;
}

export interface ConfirmationResolution {
  approved: boolean;
  principalId: string;
  resolvedAt: string;
}

export interface PendingConfirmation {
  actionRef: string;
  description: string;
  requestedAt: string;
  resolution?: ConfirmationResolution;
  consumedAt?: string;
}

export interface Task {
  id: string;
  identityId: string;
  title: string;
  spec: string;
  status: TaskStatus;
  waitingOn: WaitingOn | null;
  sponsorId: string;
  homeAnchor: Anchor;
  originEventId: string;
  wakeAt: string | null;
  pendingConfirmation: PendingConfirmation | null;
  recurrence: string | null;
  tier: "low" | "medium" | "high";
  artifacts: string[];
  terminalReport: string | null;
  createdAt: string;
  updatedAt: string;
  openedAt: string;
  consecutiveInterruptions: number;
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
