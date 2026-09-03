// Task ledger: all task/execution state changes go through transition().
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { orm } from "./db";
import { tasks, type Task } from "./schema";
import { writeAudit } from "./audit";
import { getTask, ledgerView, liveExecutionId, nextTaskId, requireTask } from "./tasks-query";
import type { Anchor } from "./tasks-types";
import { RecurrenceRequiresOperatorError } from "./tasks-types";

export { IllegalTransitionError, RecurrenceRequiresOperatorError } from "./tasks-types";
export {
  consumeConfirmation,
  requestConfirmation,
  resolveConfirmation,
  type RequestConfirmationParams,
  type ResolveConfirmationParams,
} from "./tasks-confirmation";
export { consumeSteering, steerTask } from "./tasks-steer";
export { getTask, ledgerView, liveExecutionId, nextTaskId, requireTask };
export { transition, type TransitionOpts } from "./tasks-transition";

// Causes never post to Slack — ledger records state only.

export interface CreateTaskParams {
  id: string;
  identityId: string;
  title: string;
  spec: string;
  sponsorId: string;
  homeAnchor: Anchor;
  originEventId: string;
  recurrence?: string | undefined;
  tier?: Task["tier"] | undefined;
  sponsorIsOperator?: boolean | undefined;
}

export function createTask(db: Database, clock: Clock, params: CreateTaskParams): Task {
  if (params.recurrence && !params.sponsorIsOperator) {
    throw new RecurrenceRequiresOperatorError();
  }
  const now = clock();
  orm(db)
    .insert(tasks)
    .values({
      id: params.id,
      identityId: params.identityId,
      title: params.title,
      spec: params.spec,
      status: "open",
      waitingOn: null,
      sponsorId: params.sponsorId,
      homeVenueId: params.homeAnchor.venueId,
      homeThreadRootId: params.homeAnchor.threadRootId,
      originEventId: params.originEventId,
      wakeAt: null,
      pendingConfirmation: null,
      recurrence: params.recurrence ?? null,
      tier: params.tier ?? "high",
      artifacts: [],
      terminalReport: null,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      consecutiveInterruptions: 0,
    })
    .run();
  writeAudit(db, now, params.identityId, "task_created", {
    taskId: params.id,
    title: params.title,
  });
  return requireTask(db, params.id);
}
