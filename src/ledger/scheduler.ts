import { now } from "./clock";
import { log } from "../log";
import { transition } from "./tasks-transition";
import { and, asc, count, eq, lte, min } from "drizzle-orm";
import type { Ledger } from "./db";
import { tasks } from "./schema";

/** Returns whether any human-waited task expired: she should hear about it. */
export function wakeDueTasks(db: Ledger): boolean {
  const due = db
    .select({ id: tasks.id, waitingOn: tasks.waitingOn })
    .from(tasks)
    .where(and(eq(tasks.status, "waiting"), lte(tasks.wakeAt, now())))
    .all();
  for (const task of due) {
    if (task.waitingOn === "timer") transition(db, task.id, { type: "wake" });
    else
      transition(db, task.id, {
        type: "finish",
        outcome: "expired",
        report: "No answer arrived before the deadline; the task was closed without acting.",
      });
  }
  return due.some((task) => task.waitingOn === "human");
}

export function msUntilNextWake(db: Ledger, maxMs: number): number {
  const next = db
    .select({ next: min(tasks.wakeAt) })
    .from(tasks)
    .where(eq(tasks.status, "waiting"))
    .get()?.next;
  if (!next) return maxMs;
  return Math.max(0, Math.min(Date.parse(next) - Date.now(), maxMs));
}

export function dispatchRunnable(db: Ledger, maxConcurrent: number): string[] {
  const running =
    db.select({ c: count() }).from(tasks).where(eq(tasks.status, "active")).get()?.c ?? 0;
  const open = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, "open"))
    .orderBy(asc(tasks.openedAt), asc(tasks.id))
    .limit(Math.max(0, maxConcurrent - running))
    .all();
  for (const { id } of open) transition(db, id, { type: "dispatch" });
  return open.map((row) => row.id);
}

export function interrupt(
  db: Ledger,
  taskId: string,
  maxInterruptions: number,
): "reopened" | "failed" {
  const task = transition(db, taskId, { type: "wake" });
  if (task.interruptions <= maxInterruptions) return "reopened";
  transition(db, taskId, {
    type: "finish",
    outcome: "failed",
    report: `The worker was interrupted ${task.interruptions} times in a row and the task was closed without finishing.`,
  });
  return "failed";
}

export function recoverFromRestart(db: Ledger, maxInterruptions: number): void {
  for (const { id } of db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.status, "active"))
    .all())
    log.info("restart recovery", { taskId: id, result: interrupt(db, id, maxInterruptions) });
}
