import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import type { Timer } from "./schema";
import { getTask } from "./tasks-query";
import { transition } from "./tasks-transition";
import { and, lte, asc, count, eq, isNull, min } from "drizzle-orm";
import { orm } from "./db";
import { executions, tasks, timers, type Task, type WaitingOn } from "./schema";

function isCurrent(task: Task | null, waitingOn: WaitingOn, dueAt: string): task is Task {
  return (
    task !== null &&
    task.status === "waiting" &&
    task.waitingOn === waitingOn &&
    task.wakeAt === dueAt
  );
}

function applyTimer(db: Database, clock: Clock, timer: Timer): boolean {
  switch (timer.kind) {
    case "task_wake": {
      const task = getTask(db, timer.subjectId!);
      if (!isCurrent(task, "timer", timer.dueAt)) return false;
      transition(db, clock, task.id, { type: "revive" });
      return true;
    }
    case "park": {
      const task = getTask(db, timer.subjectId!);
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

export function fireDueTimers(db: Database, clock: Clock) {
  const due = orm(db)
    .select()
    .from(timers)
    .where(and(isNull(timers.firedAt), lte(timers.dueAt, clock())))
    .orderBy(asc(timers.dueAt), asc(timers.id))
    .all();
  return due.map((timer) => {
    const applied = applyTimer(db, clock, timer);
    orm(db).update(timers).set({ firedAt: clock() }).where(eq(timers.id, timer.id)).run();
    return Object.assign(timer, { applied });
  });
}

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

  for (const row of openTasks) {
    if (globalRunning >= opts.maxConcurrentGlobal) continue;
    const identityRunning = runningByIdentity.get(row.identityId) ?? 0;
    if (identityRunning >= opts.maxConcurrentPerIdentity) continue;
    transition(db, clock, row.id, {
      type: "dispatch",
      executionId: opts.newExecutionId(),
    });
    dispatched.push(row.id);
    runningByIdentity.set(row.identityId, identityRunning + 1);
    globalRunning += 1;
  }

  return dispatched;
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
