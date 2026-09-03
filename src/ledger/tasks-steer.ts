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
  | { kind: "pause" }
  | { kind: "resume" }
);

export function steerTask(
  db: Database,
  clock: Clock,
  identityId: string,
  params: Steer,
): SteerResult {
  const task = requireTaskFor(db, identityId, params.taskId);
  if (task.status === "done" || task.status === "failed" || task.status === "cancelled")
    return { applied: false, task, reply: `${task.id} already ${task.status}` };
  if (params.kind === "guidance") {
    orm(db)
      .update(tasks)
      .set({ spec: sql`${tasks.spec} || ${`\n\n${params.text}`}`, updatedAt: clock() })
      .where(eq(tasks.id, task.id))
      .run();
    const revive =
      task.status === "parked" || (task.status === "waiting" && task.waitingOn === "human");
    return {
      applied: true,
      task: revive ? transition(db, clock, task.id, { type: "revive" }) : requireTask(db, task.id),
    };
  }
  if (params.kind === "cancel")
    return {
      applied: true,
      task: transition(db, clock, task.id, {
        type: "cancelled",
        report: params.report ?? `Cancelled "${task.title}".`,
      }),
    };
  if (params.kind === "pause") {
    if (task.status === "parked")
      return { applied: false, task, reply: `${task.id} is already parked` };
    if (task.status === "active")
      return { applied: false, task, reply: `${task.id} is active; use cancel to stop live work` };
    return { applied: true, task: transition(db, clock, task.id, { type: "paused" }) };
  }
  if (task.status !== "parked") return { applied: false, task, reply: `${task.id} is not parked` };
  return { applied: true, task: transition(db, clock, task.id, { type: "revive" }) };
}
