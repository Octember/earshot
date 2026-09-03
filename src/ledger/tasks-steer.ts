import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import {
  steering,
  tasks,
  type Steering,
  type SteerPayload,
  type SteeringKind,
  type Task,
} from "./schema";
import { requireTask, requireTaskFor } from "./tasks-query";
import { transition } from "./tasks-transition";

export interface SteerResult {
  applied: boolean;
  task: Task;
  reply?: string;
}

export function steerTask(
  db: Database,
  clock: Clock,
  params: {
    identityId: string;
    taskId: string;
    kind: Exclude<SteeringKind, "confirm">;
    payload: SteerPayload;
    sourceEventId: string;
  },
): SteerResult {
  const task = requireTaskFor(db, params.identityId, params.taskId);
  const terminal =
    task.status === "done" || task.status === "failed" || task.status === "cancelled";
  const now = clock();
  orm(db)
    .insert(steering)
    .values({
      id: `${task.id}-steer-${now}-${crypto.randomUUID().slice(0, 8)}`,
      taskId: task.id,
      kind: params.kind,
      payload: params.payload,
      sourceEventId: params.sourceEventId,
      createdAt: now,
      consumedAt:
        task.status !== "active" || params.kind === "pause" || params.kind === "resume"
          ? now
          : null,
    })
    .run();
  if (terminal) return { applied: false, task, reply: `${task.id} already ${task.status}` };
  switch (params.kind) {
    case "guidance": {
      orm(db)
        .update(tasks)
        .set({ spec: sql`${tasks.spec} || ${`\n\n${params.payload.text ?? ""}`}`, updatedAt: now })
        .where(eq(tasks.id, task.id))
        .run();
      const revive =
        task.status === "parked" || (task.status === "waiting" && task.waitingOn === "human");
      return {
        applied: true,
        task: revive
          ? transition(db, clock, task.id, { type: "revive" })
          : requireTask(db, task.id),
      };
    }
    case "cancel":
      return {
        applied: true,
        task: transition(db, clock, task.id, {
          type: "cancelled",
          report: params.payload.report ?? `Cancelled "${task.title}".`,
        }),
      };
    case "pause":
      if (task.status === "parked")
        return { applied: false, task, reply: `${task.id} is already parked` };
      if (task.status === "active")
        return {
          applied: false,
          task,
          reply: `${task.id} is active; use cancel to stop live work`,
        };
      return { applied: true, task: transition(db, clock, task.id, { type: "paused" }) };
    case "resume":
      if (task.status !== "parked")
        return { applied: false, task, reply: `${task.id} is not parked` };
      return { applied: true, task: transition(db, clock, task.id, { type: "revive" }) };
    default:
      throw new Error(`unhandled steer kind: ${String(params.kind)}`);
  }
}

export function consumeSteering(db: Database, clock: Clock, taskId: string): Steering[] {
  const rows = orm(db)
    .select()
    .from(steering)
    .where(and(eq(steering.taskId, taskId), isNull(steering.consumedAt)))
    .orderBy(asc(steering.createdAt))
    .all();
  const now = clock();
  for (const row of rows) {
    orm(db).update(steering).set({ consumedAt: now }).where(eq(steering.id, row.id)).run();
    row.consumedAt = now;
  }
  return rows;
}
