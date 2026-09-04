import { eq } from "drizzle-orm";
import type { Clock } from "./clock";
import type { Ledger } from "./db";
import { tasks, type Task } from "./schema";
import { requireTask } from "./tasks-query";
import type { TransitionCause } from "./tasks-types";

const LEGAL: Record<Task["status"], readonly Task["status"][]> = {
  open: ["active", "done"],
  active: ["waiting", "open", "done"],
  waiting: ["open", "done"],
  done: [],
};

export function transition(db: Ledger, clock: Clock, taskId: string, cause: TransitionCause): Task {
  const task = requireTask(db, taskId);
  const now = clock();
  const fields: Partial<Task> & { status: Task["status"] } = {
    status: "open",
    waitingOn: null,
    waitingWhy: null,
    wakeAt: null,
    updatedAt: now,
  };
  if (cause.type === "dispatch") fields.status = "active";
  else if (cause.type === "wait") {
    fields.status = "waiting";
    fields.waitingOn = cause.waitingOn;
    fields.wakeAt = cause.wakeAt;
    if (cause.waitingOn === "human") fields.waitingWhy = cause.why;
  } else if (cause.type === "wake") {
    fields.status = "open";
    fields.openedAt = now;
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
