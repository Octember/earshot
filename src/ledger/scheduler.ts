import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { transition } from "./tasks-transition";
import { and, lte, asc, count, eq, isNull, min } from "drizzle-orm";
import { orm } from "./db";
import { tasks, timers } from "./schema";

export function fireDueTimers(db: Database, clock: Clock): string[] {
  const now = clock();
  const due = orm(db)
    .select({ id: timers.id, identityId: timers.identityId })
    .from(timers)
    .where(and(isNull(timers.firedAt), lte(timers.dueAt, now)))
    .all();
  for (const timer of due)
    orm(db).update(timers).set({ firedAt: now }).where(eq(timers.id, timer.id)).run();
  return due.map((timer) => timer.identityId);
}

export function wakeDueTasks(db: Database, clock: Clock): string[] {
  const due = orm(db)
    .select({ id: tasks.id, identityId: tasks.identityId, waitingOn: tasks.waitingOn })
    .from(tasks)
    .where(and(eq(tasks.status, "waiting"), lte(tasks.wakeAt, clock())))
    .all();
  for (const task of due) {
    if (task.waitingOn === "timer") transition(db, clock, task.id, { type: "wake" });
    else
      transition(db, clock, task.id, {
        type: "finish",
        outcome: "expired",
        report: "No answer arrived before the deadline; the task was closed without acting.",
      });
  }
  return due.filter((task) => task.waitingOn === "human").map((task) => task.identityId);
}

export function msUntilNextTimer(db: Database, clock: Clock, maxMs: number): number {
  const timer = orm(db)
    .select({ next: min(timers.dueAt) })
    .from(timers)
    .where(isNull(timers.firedAt))
    .get();
  const task = orm(db)
    .select({ next: min(tasks.wakeAt) })
    .from(tasks)
    .where(eq(tasks.status, "waiting"))
    .get();
  const nexts = [timer?.next, task?.next].filter((at): at is string => !!at);
  if (nexts.length === 0) return maxMs;
  const delta = new Date(nexts.toSorted()[0]!).getTime() - new Date(clock()).getTime();
  return Math.max(0, Math.min(delta, maxMs));
}

export function dispatchRunnable(
  db: Database,
  clock: Clock,
  opts: { maxConcurrentPerIdentity: number; maxConcurrentGlobal: number },
): string[] {
  const openTasks = orm(db)
    .select({ id: tasks.id, identityId: tasks.identityId })
    .from(tasks)
    .where(eq(tasks.status, "open"))
    .orderBy(asc(tasks.openedAt), asc(tasks.id))
    .all();
  const runningByIdentity = new Map<string, number>();
  for (const row of orm(db)
    .select({ identityId: tasks.identityId, c: count() })
    .from(tasks)
    .where(eq(tasks.status, "active"))
    .groupBy(tasks.identityId)
    .all())
    runningByIdentity.set(row.identityId, row.c);
  let globalRunning = [...runningByIdentity.values()].reduce((sum, c) => sum + c, 0);
  const dispatched: string[] = [];
  for (const row of openTasks) {
    if (globalRunning >= opts.maxConcurrentGlobal) continue;
    const identityRunning = runningByIdentity.get(row.identityId) ?? 0;
    if (identityRunning >= opts.maxConcurrentPerIdentity) continue;
    transition(db, clock, row.id, { type: "dispatch" });
    dispatched.push(row.id);
    runningByIdentity.set(row.identityId, identityRunning + 1);
    globalRunning += 1;
  }
  return dispatched;
}

export function interrupt(
  db: Database,
  clock: Clock,
  taskId: string,
  maxInterruptions: number,
): "reopened" | "failed" {
  const task = transition(db, clock, taskId, { type: "wake" });
  if (task.interruptions <= maxInterruptions) return "reopened";
  transition(db, clock, taskId, {
    type: "finish",
    outcome: "failed",
    report: `The worker was interrupted ${task.interruptions} times in a row and the task was closed without finishing.`,
  });
  return "failed";
}

export function recoverFromRestart(
  db: Database,
  clock: Clock,
  maxInterruptions: number,
): { reopened: string[]; failed: string[] } {
  const reopened: string[] = [];
  const failed: string[] = [];
  for (const { id } of orm(db)
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, "active"))
    .all())
    (interrupt(db, clock, id, maxInterruptions) === "failed" ? failed : reopened).push(id);
  return { reopened, failed };
}
