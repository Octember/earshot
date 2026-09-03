import type { Database } from "bun:sqlite";
import { eq, sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { tasks, type Task } from "./schema";
import { requireTask, requireTaskFor } from "./tasks-query";
import { transition } from "./tasks-transition";

export interface SteerResult {
  applied: boolean;
  task: Task;
  reply?: string;
}

export type Steer = { taskId: string } & (
  | { kind: "guidance"; text: string }
  | { kind: "cancel"; report?: string | undefined }
);

export function steerTask(
  db: Database,
  clock: Clock,
  identityId: string,
  params: Steer,
): SteerResult {
  const task = requireTaskFor(db, identityId, params.taskId);
  if (task.status === "done")
    return { applied: false, task, reply: `${task.id} already ${task.outcome}` };
  if (params.kind === "cancel")
    return {
      applied: true,
      task: transition(db, clock, task.id, {
        type: "finish",
        outcome: "cancelled",
        report: params.report ?? `Cancelled "${task.title}".`,
      }),
    };
  orm(db)
    .update(tasks)
    .set({ spec: sql`${tasks.spec} || ${`\n\n${params.text}`}`, updatedAt: clock() })
    .where(eq(tasks.id, task.id))
    .run();
  const revive = task.status === "waiting" && task.waitingOn === "human";
  return {
    applied: true,
    task: revive ? transition(db, clock, task.id, { type: "wake" }) : requireTask(db, task.id),
  };
}
