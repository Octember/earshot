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
  type TaskStatus,
} from "./schema";
import { requireTask, requireTaskFor } from "./tasks-query";
import { transition } from "./tasks-transition";

export interface SteerParams {
  identityId: string;
  taskId: string;
  kind: Exclude<SteeringKind, "confirm">;
  payload: SteerPayload;
  sourceEventId: string;
}

export interface SteerResult {
  applied: boolean;
  task: Task;
  reply?: string;
}

const TERMINAL_STATUSES = new Set<TaskStatus>(["done", "failed", "cancelled"]);

function insertSteeringRow(
  db: Database,
  clock: Clock,
  taskId: string,
  kind: Exclude<SteeringKind, "confirm">,
  payload: SteerPayload,
  sourceEventId: string,
  consumed: boolean,
): void {
  const now = clock();
  orm(db)
    .insert(steering)
    .values({
      id: `${taskId}-steer-${now}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      kind,
      payload,
      sourceEventId,
      createdAt: now,
      consumedAt: consumed ? now : null,
    })
    .run();
}

function appendSpec(db: Database, clock: Clock, task: Task, addition: string): void {
  const now = clock();
  orm(db)
    .update(tasks)
    .set({ spec: sql`${tasks.spec} || ${`\n\n${addition}`}`, updatedAt: now })
    .where(eq(tasks.id, task.id))
    .run();
}

function steerGuidance(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  const text = params.payload.text ?? "";
  appendSpec(db, clock, task, text);

  const live = task.status === "active";
  insertSteeringRow(db, clock, task.id, "guidance", params.payload, params.sourceEventId, !live);

  let after = requireTask(db, task.id);
  if (
    !live &&
    (task.status === "parked" || (task.status === "waiting" && task.waitingOn === "human"))
  ) {
    after = transition(db, clock, task.id, { type: "revive" });
  }
  return { applied: true, task: after };
}

function steerCancel(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  const report = params.payload.report ?? `Cancelled "${task.title}".`;
  const wasLive = task.status === "active";
  const after = transition(db, clock, task.id, { type: "cancelled", report });
  insertSteeringRow(db, clock, task.id, "cancel", params.payload, params.sourceEventId, !wasLive);
  return { applied: true, task: after };
}

function steerPause(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  if (task.status === "parked") {
    insertSteeringRow(db, clock, task.id, "pause", params.payload, params.sourceEventId, true);
    return { applied: false, task, reply: `${task.id} is already parked` };
  }
  if (task.status === "active") {
    insertSteeringRow(db, clock, task.id, "pause", params.payload, params.sourceEventId, true);
    return { applied: false, task, reply: `${task.id} is active; use cancel to stop live work` };
  }
  const after = transition(db, clock, task.id, { type: "paused" });
  insertSteeringRow(db, clock, task.id, "pause", params.payload, params.sourceEventId, true);
  return { applied: true, task: after };
}

function steerResume(db: Database, clock: Clock, task: Task, params: SteerParams): SteerResult {
  if (task.status !== "parked") {
    insertSteeringRow(db, clock, task.id, "resume", params.payload, params.sourceEventId, true);
    return { applied: false, task, reply: `${task.id} is not parked` };
  }
  const after = transition(db, clock, task.id, { type: "revive" });
  insertSteeringRow(db, clock, task.id, "resume", params.payload, params.sourceEventId, true);
  return { applied: true, task: after };
}

export function steerTask(db: Database, clock: Clock, params: SteerParams): SteerResult {
  const task = requireTaskFor(db, params.identityId, params.taskId);

  if (TERMINAL_STATUSES.has(task.status)) {
    insertSteeringRow(
      db,
      clock,
      params.taskId,
      params.kind,
      params.payload,
      params.sourceEventId,
      true,
    );
    return { applied: false, task, reply: `${task.id} already ${task.status}` };
  }

  switch (params.kind) {
    case "guidance":
      return steerGuidance(db, clock, task, params);
    case "cancel":
      return steerCancel(db, clock, task, params);
    case "pause":
      return steerPause(db, clock, task, params);
    case "resume":
      return steerResume(db, clock, task, params);
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
