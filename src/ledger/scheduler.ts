// Execution scheduler: durable timers, dispatch, restart recovery.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import type { Timer, TimerKind } from "./schema";
import { getTask } from "./tasks-query";
import { transition } from "./tasks-transition";
import { and, lte, asc, count, eq, isNull, min } from "drizzle-orm";
import { orm } from "./db";
import { executions, tasks, timers, type Task, type WaitingOn } from "./schema";

interface FireDueTimersOpts {
  parkAfterMs: number;
}

function isCurrent(task: Task | null, waitingOn: WaitingOn, dueAt: string): task is Task {
  return (
    task !== null &&
    task.status === "waiting" &&
    task.waitingOn === waitingOn &&
    task.wakeAt === dueAt
  );
}

function subjectTaskId(timer: Timer): string {
  if (!timer.subjectId)
    throw new Error(`timer ${timer.id} of kind ${timer.kind} has no subject task id`);
  return timer.subjectId;
}

function applyTimer(db: Database, clock: Clock, timer: Timer, opts: FireDueTimersOpts): boolean {
  switch (timer.kind) {
    case "task_wake": {
      const task = getTask(db, subjectTaskId(timer));
      if (!isCurrent(task, "timer", timer.dueAt)) return false;
      transition(db, clock, task.id, { type: "revive" });
      return true;
    }
    case "nudge": {
      const task = getTask(db, subjectTaskId(timer));
      if (!isCurrent(task, "human", timer.dueAt)) return false;
      const parkDeadline = new Date(new Date(clock()).getTime() + opts.parkAfterMs).toISOString();
      transition(db, clock, task.id, { type: "nudge_sent", parkDeadline });
      return true;
    }
    case "park": {
      const task = getTask(db, subjectTaskId(timer));
      if (!isCurrent(task, "human", timer.dueAt)) return false;
      transition(db, clock, task.id, { type: "park_timeout" });
      return true;
    }
    case "distillation":
      return true;
    default: {
      const exhausted: never = timer.kind;
      throw new Error(`timer kind not yet implemented by the scheduler: ${String(exhausted)}`);
    }
  }
}

export function fireDueTimers(db: Database, clock: Clock, opts: FireDueTimersOpts) {
  const due = orm(db)
    .select()
    .from(timers)
    .where(and(isNull(timers.firedAt), lte(timers.dueAt, clock())))
    .orderBy(asc(timers.dueAt), asc(timers.id))
    .all();
  const results: Array<{
    timerId: string;
    kind: TimerKind;
    identityId: string;
    subjectId: string | null;
    applied: boolean;
  }> = [];
  for (const timer of due) {
    const applied = applyTimer(db, clock, timer, opts);
    orm(db).update(timers).set({ firedAt: clock() }).where(eq(timers.id, timer.id)).run();
    results.push({
      timerId: timer.id,
      kind: timer.kind,
      identityId: timer.identityId,
      subjectId: timer.subjectId,
      applied,
    });
  }
  return results;
}

// Ms until next unfired timer (0 if overdue), clamped to [0, maxMs].
export function msUntilNextTimer(db: Database, clock: Clock, maxMs: number): number {
  const row = orm(db)
    .select({ next: min(timers.dueAt) })
    .from(timers)
    .where(isNull(timers.firedAt))
    .get();
  if (!row?.next) return maxMs;
  const delta = new Date(row.next).getTime() - new Date(clock()).getTime();
  return Math.max(0, Math.min(delta, maxMs));
}

export function dispatchRunnable(
  db: Database,
  clock: Clock,
  opts: {
    maxConcurrentPerIdentity: number;
    maxConcurrentGlobal: number;
    hasBudgetHeadroom?: (identityId: string) => boolean;
    newExecutionId: () => string;
  },
) {
  const openTasks = orm(db)
    .select({ id: tasks.id, identityId: tasks.identityId })
    .from(tasks)
    .where(eq(tasks.status, "open"))
    .orderBy(asc(tasks.openedAt), asc(tasks.id))
    .all();

  const runningByIdentity = new Map<string, number>();
  const runningRows = orm(db)
    .select({ identityId: tasks.identityId, c: count() })
    .from(executions)
    .innerJoin(tasks, eq(tasks.id, executions.taskId))
    .where(eq(executions.status, "running"))
    .groupBy(tasks.identityId)
    .all();
  for (const row of runningRows) runningByIdentity.set(row.identityId, row.c);
  let globalRunning = runningRows.reduce((sum, row) => sum + row.c, 0);

  const dispatched: string[] = [];
  const deferredBudget: string[] = [];
  const deferredConcurrency: string[] = [];

  for (const row of openTasks) {
    if (globalRunning >= opts.maxConcurrentGlobal) {
      deferredConcurrency.push(row.id);
      continue;
    }
    const identityRunning = runningByIdentity.get(row.identityId) ?? 0;
    if (identityRunning >= opts.maxConcurrentPerIdentity) {
      deferredConcurrency.push(row.id);
      continue;
    }
    if (opts.hasBudgetHeadroom && !opts.hasBudgetHeadroom(row.identityId)) {
      deferredBudget.push(row.id);
      continue;
    }
    transition(db, clock, row.id, {
      type: "dispatch",
      executionId: opts.newExecutionId(),
    });
    dispatched.push(row.id);
    runningByIdentity.set(row.identityId, identityRunning + 1);
    globalRunning += 1;
  }

  return { dispatched, deferredBudget, deferredConcurrency };
}

export function interruptOrPark(
  db: Database,
  clock: Clock,
  taskId: string,
  currentConsecutiveInterruptions: number,
  maxConsecutiveInterruptions: number,
): "reopened" | "parked" {
  const nextCount = currentConsecutiveInterruptions + 1;
  if (nextCount > maxConsecutiveInterruptions) {
    transition(db, clock, taskId, { type: "crash_loop_parked" });
    return "parked";
  }
  transition(db, clock, taskId, { type: "interrupted" });
  return "reopened";
}

// Orphaned 'active' tasks at startup → interrupt or park past the crash-loop bound.
export function recoverFromRestart(
  db: Database,
  clock: Clock,
  opts: { maxConsecutiveInterruptions: number },
) {
  const orphaned = orm(db)
    .select({ id: tasks.id, consecutiveInterruptions: tasks.consecutiveInterruptions })
    .from(tasks)
    .where(eq(tasks.status, "active"))
    .all();
  const reopened: string[] = [];
  const parked: string[] = [];

  for (const { id, consecutiveInterruptions } of orphaned) {
    const outcome = interruptOrPark(
      db,
      clock,
      id,
      consecutiveInterruptions,
      opts.maxConsecutiveInterruptions,
    );
    (outcome === "parked" ? parked : reopened).push(id);
  }

  return { reopened, parked };
}
