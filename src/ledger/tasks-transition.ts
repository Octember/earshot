import type { Database } from "bun:sqlite";
import { eq, max } from "drizzle-orm";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import type { AuditKind } from "./schema";
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
import { IllegalTransitionError, type TransitionCause } from "./tasks-types";
import type { PendingConfirmation } from "../schemas/tasks-json";

type TransitionFields = {
  waitingOn: WaitingOn | null;
  wakeAt: string | null;
  terminalReport: string | null;
  pendingConfirmation: PendingConfirmation | null;
  recurrence: string | null;
  openedAt: string;
  consecutiveInterruptions: number;
};

export const LEGAL: Record<TaskStatus, Partial<Record<TransitionCause["type"], TaskStatus>>> = {
  open: { dispatch: "active", cancelled: "cancelled", paused: "parked" },
  active: {
    yield_human: "waiting",
    yield_timer: "waiting",
    yield_external: "waiting",
    yield_open: "open",
    interrupted: "open",
    crash_loop_parked: "parked",
    completed: "done",
    failed: "failed",
    cancelled: "cancelled",
    recurrence_rearm: "waiting",
    recurrence_failed: "waiting",
  },
  waiting: {
    nudge_sent: "waiting",
    park_timeout: "parked",
    revive: "open",
    cancelled: "cancelled",
    paused: "parked",
  },
  parked: { revive: "open", cancelled: "cancelled" },
  done: {},
  failed: {},
  cancelled: {},
};

export function assertLegalTransition(task: Task, to: TaskStatus, cause: TransitionCause): void {
  const expected = LEGAL[task.status]?.[cause.type];
  if (expected !== to) {
    throw new IllegalTransitionError(task.id, task.status, to, cause.type);
  }
  if (cause.type === "park_timeout" && task.waitingOn !== "human") {
    throw new IllegalTransitionError(task.id, task.status, to, cause.type);
  }
  if (
    (cause.type === "recurrence_rearm" || cause.type === "recurrence_failed") &&
    !task.recurrence
  ) {
    throw new IllegalTransitionError(task.id, task.status, to, cause.type);
  }
}

export function initialTransitionFields(
  task: Task,
  to: TaskStatus,
  cause: TransitionCause,
  now: string,
): TransitionFields {
  let consecutiveInterruptions = task.consecutiveInterruptions;
  if (cause.type === "interrupted") consecutiveInterruptions += 1;
  else if (cause.type !== "dispatch") consecutiveInterruptions = 0;
  return {
    waitingOn: task.waitingOn,
    wakeAt: task.wakeAt,
    terminalReport: task.terminalReport,
    pendingConfirmation: task.pendingConfirmation,
    recurrence: task.recurrence,
    openedAt: to === "open" ? now : task.openedAt,
    consecutiveInterruptions,
  };
}

function startExecution(db: Database, taskId: string, executionId: string, now: string): void {
  const attempt =
    (orm(db)
      .select({ m: max(executions.attempt) })
      .from(executions)
      .where(eq(executions.taskId, taskId))
      .get()?.m ?? 0) + 1;
  orm(db)
    .insert(executions)
    .values({ id: executionId, taskId, attempt, status: "running", startedAt: now, endedAt: null })
    .run();
}

function endRunningExecution(
  db: Database,
  taskId: string,
  now: string,
  status: (typeof executions.$inferSelect)["status"],
  lookupLiveExecution: (db: Database, taskId: string) => string | null,
): void {
  const execId = lookupLiveExecution(db, taskId);
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

function endYield(
  db: Database,
  taskId: string,
  now: string,
  lookupLiveExecution: (db: Database, taskId: string) => string | null,
): void {
  endRunningExecution(db, taskId, now, "yielded", lookupLiveExecution);
}

export function applyCauseEffects(
  db: Database,
  task: Task,
  taskId: string,
  cause: TransitionCause,
  now: string,
  fields: TransitionFields,
  lookupLiveExecution: (db: Database, taskId: string) => string | null,
): void {
  switch (cause.type) {
    case "dispatch":
      startExecution(db, taskId, cause.executionId, now);
      clearWait(fields);
      break;
    case "yield_human":
      fields.waitingOn = "human";
      fields.wakeAt = cause.nudgeDeadline;
      if (cause.pendingConfirmation !== undefined)
        fields.pendingConfirmation = cause.pendingConfirmation;
      endYield(db, taskId, now, lookupLiveExecution);
      scheduleWakeTimer(db, task, "nudge", cause.nudgeDeadline);
      break;
    case "yield_timer":
      fields.waitingOn = "timer";
      fields.wakeAt = cause.wakeAt;
      endYield(db, taskId, now, lookupLiveExecution);
      scheduleWakeTimer(db, task, "task_wake", cause.wakeAt);
      break;
    case "yield_external":
      fields.waitingOn = "external";
      fields.wakeAt = null;
      endYield(db, taskId, now, lookupLiveExecution);
      break;
    case "yield_open":
      clearWait(fields);
      endYield(db, taskId, now, lookupLiveExecution);
      break;
    case "interrupted":
      clearWait(fields);
      endRunningExecution(db, taskId, now, "interrupted", lookupLiveExecution);
      break;
    case "crash_loop_parked":
      clearWait(fields);
      endRunningExecution(db, taskId, now, "interrupted", lookupLiveExecution);
      break;
    case "completed":
      fields.terminalReport = cause.report;
      fields.pendingConfirmation = null;
      endRunningExecution(db, taskId, now, "succeeded", lookupLiveExecution);
      break;
    case "failed":
      fields.terminalReport = cause.report;
      fields.pendingConfirmation = null;
      endRunningExecution(db, taskId, now, "failed", lookupLiveExecution);
      break;
    case "cancelled":
      fields.terminalReport = cause.report;
      fields.pendingConfirmation = null;
      fields.waitingOn = null;
      endRunningExecution(db, taskId, now, "cancelled", lookupLiveExecution);
      break;
    case "paused":
      clearWait(fields);
      break;
    case "nudge_sent":
      fields.wakeAt = cause.parkDeadline;
      scheduleWakeTimer(db, task, "park", cause.parkDeadline);
      break;
    case "park_timeout":
      clearWait(fields);
      break;
    case "revive":
      clearWait(fields);
      if (cause.pendingConfirmation !== undefined)
        fields.pendingConfirmation = cause.pendingConfirmation;
      break;
    case "recurrence_rearm":
      fields.waitingOn = "timer";
      fields.wakeAt = cause.wakeAt;
      endRunningExecution(db, taskId, now, "succeeded", lookupLiveExecution);
      scheduleWakeTimer(db, task, "task_wake", cause.wakeAt);
      break;
    case "recurrence_failed":
      fields.waitingOn = "timer";
      fields.wakeAt = cause.wakeAt;
      endRunningExecution(db, taskId, now, "failed", lookupLiveExecution);
      scheduleWakeTimer(db, task, "task_wake", cause.wakeAt);
      break;
    default: {
      const exhaustive: never = cause;
      throw new Error(`unhandled transition cause: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export function persistTransition(
  db: Database,
  taskId: string,
  to: TaskStatus,
  now: string,
  fields: TransitionFields,
): void {
  orm(db)
    .update(tasks)
    .set({
      status: to,
      waitingOn: fields.waitingOn,
      wakeAt: fields.wakeAt,
      terminalReport: fields.terminalReport,
      pendingConfirmation: fields.pendingConfirmation ? { ...fields.pendingConfirmation } : null,
      recurrence: fields.recurrence,
      openedAt: fields.openedAt,
      consecutiveInterruptions: fields.consecutiveInterruptions,
      updatedAt: now,
    })
    .where(eq(tasks.id, taskId))
    .run();
}

function applyTransition(
  db: Database,
  clock: Clock,
  taskId: string,
  to: TaskStatus,
  cause: TransitionCause,
): Task {
  const task = requireTask(db, taskId);
  assertLegalTransition(task, to, cause);
  const now = clock();
  const fields = initialTransitionFields(task, to, cause, now);
  applyCauseEffects(db, task, taskId, cause, now, fields, liveExecutionId);
  persistTransition(db, taskId, to, now, fields);
  writeAudit(db, now, task.identityId, "task_transitioned", {
    taskId,
    from: task.status,
    to,
    cause: cause.type,
  });
  return requireTask(db, taskId);
}

export interface TransitionOpts {
  extraAudit?: Array<{ kind: AuditKind; payload: unknown }>;
}

export function transition(
  db: Database,
  clock: Clock,
  taskId: string,
  to: TaskStatus,
  cause: TransitionCause,
  opts: TransitionOpts = {},
): Task {
  db.run("BEGIN IMMEDIATE");
  try {
    const task = applyTransition(db, clock, taskId, to, cause);
    for (const entry of opts.extraAudit ?? []) {
      writeAudit(db, clock(), task.identityId, entry.kind, entry.payload);
    }
    db.run("COMMIT");
    return task;
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
}
