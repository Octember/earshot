import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import { orm } from "./db";
import {
  executions,
  tasks,
  type Task,
  type TaskStatus,
  type TimerKind,
  type WaitingOn,
} from "./schema";
import { liveExecutionId, requireTask } from "./tasks-query";
import { scheduleTimer } from "./timers";
import type { TransitionCause } from "./tasks-types";

type TransitionFields = {
  waitingOn: WaitingOn | null;
  wakeAt: string | null;
  terminalReport: string | null;
  openedAt: string;
  consecutiveInterruptions: number;
};

const TARGET_STATUS: Record<TransitionCause["type"], TaskStatus> = {
  dispatch: "active",
  yield_human: "waiting",
  yield_timer: "waiting",
  yield_open: "open",
  interrupted: "open",
  crash_loop_parked: "parked",
  completed: "done",
  failed: "failed",
  cancelled: "cancelled",
  paused: "parked",
  park_timeout: "parked",
  revive: "open",
};

function startExecution(db: Database, taskId: string, executionId: string, now: string): void {
  orm(db)
    .insert(executions)
    .values({ id: executionId, taskId, status: "running", startedAt: now, endedAt: null })
    .run();
}

function endRunningExecution(
  db: Database,
  taskId: string,
  now: string,
  status: (typeof executions.$inferSelect)["status"],
): void {
  const execId = liveExecutionId(db, taskId);
  if (!execId) return;
  orm(db).update(executions).set({ status, endedAt: now }).where(eq(executions.id, execId)).run();
}

function scheduleWakeTimer(db: Database, task: Task, kind: TimerKind, dueAt: string): void {
  scheduleTimer(db, {
    id: `${task.id}:${kind}:${dueAt}`,
    kind,
    identityId: task.identityId,
    subjectId: task.id,
    dueAt,
  });
}

function clearWait(fields: TransitionFields): void {
  fields.waitingOn = null;
  fields.wakeAt = null;
}

function applyCauseEffects(
  db: Database,
  task: Task,
  taskId: string,
  cause: TransitionCause,
  now: string,
  fields: TransitionFields,
): void {
  switch (cause.type) {
    case "dispatch":
      startExecution(db, taskId, cause.executionId, now);
      clearWait(fields);
      break;
    case "yield_human":
      fields.waitingOn = "human";
      fields.wakeAt = cause.parkDeadline;
      endRunningExecution(db, taskId, now, "yielded");
      scheduleWakeTimer(db, task, "park", cause.parkDeadline);
      break;
    case "yield_timer":
      fields.waitingOn = "timer";
      fields.wakeAt = cause.wakeAt;
      endRunningExecution(db, taskId, now, "yielded");
      scheduleWakeTimer(db, task, "task_wake", cause.wakeAt);
      break;
    case "yield_open":
      clearWait(fields);
      endRunningExecution(db, taskId, now, "yielded");
      break;
    case "interrupted":
      clearWait(fields);
      endRunningExecution(db, taskId, now, "interrupted");
      break;
    case "crash_loop_parked":
      clearWait(fields);
      endRunningExecution(db, taskId, now, "interrupted");
      break;
    case "completed":
      fields.terminalReport = cause.report;
      endRunningExecution(db, taskId, now, "succeeded");
      break;
    case "failed":
      fields.terminalReport = cause.report;
      endRunningExecution(db, taskId, now, "failed");
      break;
    case "cancelled":
      fields.terminalReport = cause.report;
      clearWait(fields);
      endRunningExecution(db, taskId, now, "cancelled");
      break;
    case "paused":
      clearWait(fields);
      break;
    case "park_timeout":
      clearWait(fields);
      break;
    case "revive":
      clearWait(fields);
      break;
    default: {
      const exhaustive: never = cause;
      throw new Error(`unhandled transition cause: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function transition(
  db: Database,
  clock: Clock,
  taskId: string,
  cause: TransitionCause,
): Task {
  return db
    .transaction(() => {
      const task = requireTask(db, taskId);
      if (cause.type === "park_timeout" && task.waitingOn !== "human")
        throw new Error(
          `illegal task transition: ${task.id} park_timeout while waiting on ${task.waitingOn}`,
        );
      const to = TARGET_STATUS[cause.type];
      const now = clock();
      let consecutiveInterruptions = task.consecutiveInterruptions;
      if (cause.type === "interrupted") consecutiveInterruptions += 1;
      else if (cause.type !== "dispatch") consecutiveInterruptions = 0;
      const fields: TransitionFields = {
        waitingOn: task.waitingOn,
        wakeAt: task.wakeAt,
        terminalReport: task.terminalReport,
        openedAt: to === "open" ? now : task.openedAt,
        consecutiveInterruptions,
      };
      applyCauseEffects(db, task, taskId, cause, now, fields);
      orm(db)
        .update(tasks)
        .set({
          status: to,
          ...fields,
          updatedAt: now,
        })
        .where(eq(tasks.id, taskId))
        .run();
      writeAudit(db, now, task.identityId, {
        kind: "task_transitioned",
        payload: { taskId, from: task.status, to, cause: cause.type },
      });
      return requireTask(db, taskId);
    })
    .immediate();
}
