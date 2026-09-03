import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { tasks, type Task } from "./schema";
import { requireTask } from "./tasks-query";
import type { TransitionCause } from "./tasks-types";

export function transition(
  db: Database,
  clock: Clock,
  taskId: string,
  cause: TransitionCause,
): Task {
  return db
    .transaction(() => {
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
      orm(db).update(tasks).set(fields).where(eq(tasks.id, taskId)).run();
      return requireTask(db, taskId);
    })
    .immediate();
}
