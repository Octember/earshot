import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { orm } from "./db";
import { executions, tasks, type TaskRow } from "./schema";
import type { Task } from "./tasks-types";
import { parsePendingConfirmation, parseTaskArtifacts } from "../schemas/tasks-json";

class TaskNotFoundError extends Error {
  constructor(taskId: string) {
    super(`no such task: ${taskId}`);
    this.name = "TaskNotFoundError";
  }
}

export function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    identityId: row.identityId,
    title: row.title,
    spec: row.spec,
    status: row.status,
    waitingOn: row.waitingOn,
    sponsorId: row.sponsorId,
    homeAnchor: { venueId: row.homeVenueId, threadRootId: row.homeThreadRootId },
    originEventId: row.originEventId,
    wakeAt: row.wakeAt,
    pendingConfirmation: parsePendingConfirmation(row.pendingConfirmation),
    recurrence: row.recurrence,
    tier: row.tier,
    artifacts: parseTaskArtifacts(row.artifacts),
    terminalReport: row.terminalReport,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    openedAt: row.openedAt,
    consecutiveInterruptions: row.consecutiveInterruptions,
  };
}

export function getTask(db: Database, taskId: string): Task | null {
  const row = orm(db).select().from(tasks).where(eq(tasks.id, taskId)).get();
  return row ? rowToTask(row) : null;
}

export function requireTask(db: Database, taskId: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  return task;
}

// Cross-identity ids look nonexistent (§7.1).
export function requireTaskFor(db: Database, identityId: string, taskId: string): Task {
  const task = getTask(db, taskId);
  if (!task || task.identityId !== identityId) throw new TaskNotFoundError(taskId);
  return task;
}

export function nextTaskId(db: Database): string {
  const row = orm(db)
    .select({ n: sql<number | null>`MAX(CAST(SUBSTR(${tasks.id}, 3) AS INTEGER))` })
    .from(tasks)
    .where(sql`${tasks.id} LIKE 'T-%'`)
    .get();
  return `T-${(row?.n ?? 0) + 1}`;
}

export function ledgerView(
  db: Database,
  identityId: string,
  recentTerminalsLimit = 10,
): { open: Task[]; recentTerminals: Task[] } {
  const openRows = orm(db)
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.identityId, identityId),
        notInArray(tasks.status, ["done", "failed", "cancelled"]),
      ),
    )
    .orderBy(asc(tasks.openedAt))
    .all();
  const terminalRows = orm(db)
    .select()
    .from(tasks)
    .where(
      and(eq(tasks.identityId, identityId), inArray(tasks.status, ["done", "failed", "cancelled"])),
    )
    .orderBy(desc(tasks.updatedAt))
    .limit(recentTerminalsLimit)
    .all();
  return {
    open: openRows.map((row) => rowToTask(row)),
    recentTerminals: terminalRows.map((row) => rowToTask(row)),
  };
}

export function liveExecutionId(db: Database, taskId: string): string | null {
  const row = orm(db)
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.taskId, taskId), eq(executions.status, "running")))
    .get();
  return row?.id ?? null;
}
