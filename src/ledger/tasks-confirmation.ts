import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { tasks } from "./schema";
import { requireTask, requireTaskFor } from "./tasks-query";
import { transition } from "./tasks-transition";
import type { ConfirmationResolution, PendingConfirmation, Task } from "./tasks-types";
import type { SteerResult } from "./tasks-steer";

export interface RequestConfirmationParams {
  taskId: string;
  actionRef: string;
  description: string;
  nudgeDeadline: string;
}

export function requestConfirmation(
  db: Database,
  clock: Clock,
  params: RequestConfirmationParams,
): Task {
  const pendingConfirmation: PendingConfirmation = {
    actionRef: params.actionRef,
    description: params.description,
    requestedAt: clock(),
  };
  return transition(
    db,
    clock,
    params.taskId,
    "waiting",
    { type: "yield_human", nudgeDeadline: params.nudgeDeadline, pendingConfirmation },
    {
      extraAudit: [
        {
          kind: "confirmation_requested",
          payload: { taskId: params.taskId, actionRef: params.actionRef },
        },
      ],
    },
  );
}

export interface ResolveConfirmationParams {
  identityId: string;
  taskId: string;
  principalId: string;
  approve: boolean;
}

export function resolveConfirmation(
  db: Database,
  clock: Clock,
  params: ResolveConfirmationParams,
): SteerResult {
  const task = requireTaskFor(db, params.identityId, params.taskId);
  if (
    task.status !== "waiting" ||
    task.waitingOn !== "human" ||
    !task.pendingConfirmation ||
    task.pendingConfirmation.resolution
  ) {
    return { applied: false, task, reply: `${task.id} has no pending confirmation` };
  }

  const resolution: ConfirmationResolution = {
    approved: params.approve,
    principalId: params.principalId,
    resolvedAt: clock(),
  };
  const pendingConfirmation: PendingConfirmation = { ...task.pendingConfirmation, resolution };

  const after = transition(
    db,
    clock,
    task.id,
    "open",
    { type: "revive", pendingConfirmation },
    {
      extraAudit: [
        {
          kind: "confirmation_resolved",
          payload: {
            taskId: task.id,
            actionRef: pendingConfirmation.actionRef,
            approved: params.approve,
            principalId: params.principalId,
          },
        },
      ],
    },
  );

  return { applied: true, task: after };
}

export function consumeConfirmation(db: Database, clock: Clock, taskId: string): void {
  const task = requireTask(db, taskId);
  if (!task.pendingConfirmation) return;
  const pendingConfirmation: PendingConfirmation = {
    ...task.pendingConfirmation,
    consumedAt: clock(),
  };
  orm(db)
    .update(tasks)
    .set({ pendingConfirmation: { ...pendingConfirmation }, updatedAt: clock() })
    .where(eq(tasks.id, taskId))
    .run();
}
