import { eq } from "drizzle-orm";
import { now } from "./clock";
import type { Ledger } from "./db";
import { tasks, type Task } from "./schema";
import { requireTask } from "./tasks-query";

export type TransitionCause =
  | { type: "dispatch" }
  | { type: "wait"; waitingOn: "human"; why: string; wakeAt: string }
  | { type: "wait"; waitingOn: "timer"; wakeAt: string }
  | { type: "wake" }
  | { type: "finish"; outcome: NonNullable<Task["outcome"]>; report: string };

const LEGAL: Record<Task["status"], readonly Task["status"][]> = {
  open: ["active", "done"],
  active: ["waiting", "open", "done"],
  waiting: ["open", "done"],
  done: [],
};

export function transition(db: Ledger, taskId: string, cause: TransitionCause): Task {
  const task = requireTask(db, taskId);
  const at = now();
  const fields: Partial<Task> & { status: Task["status"] } = {
    status: "open",
    waitingOn: null,
    waitingWhy: null,
    wakeAt: null,
    updatedAt: at,
  };
  if (cause.type === "dispatch") fields.status = "active";
  else if (cause.type === "wait") {
    fields.status = "waiting";
    fields.waitingOn = cause.waitingOn;
    fields.wakeAt = cause.wakeAt;
    if (cause.waitingOn === "human") fields.waitingWhy = cause.why;
  } else if (cause.type === "wake") {
    fields.status = "open";
    fields.openedAt = at;
    if (task.status === "active") fields.interruptions = task.interruptions + 1;
  } else {
    fields.status = "done";
    fields.outcome = cause.outcome;
    fields.report = cause.report;
  }
  if (!LEGAL[task.status].includes(fields.status))
    throw new Error(`illegal task transition: ${task.id} ${task.status} → ${fields.status}`);
  return db.update(tasks).set(fields).where(eq(tasks.id, taskId)).returning().get();
}
