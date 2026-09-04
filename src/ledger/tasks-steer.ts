import { eq } from "drizzle-orm";
import type { Clock } from "./clock";
import type { Ledger } from "./db";
import { tasks, type Task } from "./schema";
import { requireTask } from "./tasks-query";
import { transition } from "./tasks-transition";

export function appendGuidance(db: Ledger, clock: Clock, task: Task, text: string): Task {
  if (task.status === "done") throw new Error(`${task.id} already ${task.outcome}`);
  db.update(tasks)
    .set({ spec: `${task.spec}\n\n${text}`, updatedAt: clock() })
    .where(eq(tasks.id, task.id))
    .run();
  return task.status === "waiting" && task.waitingOn === "human"
    ? transition(db, clock, task.id, { type: "wake" })
    : requireTask(db, task.id);
}
