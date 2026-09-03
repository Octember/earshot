import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { orm } from "./db";
import { executions, tasks, type Task } from "./schema";
import { writeAudit } from "./audit";
import type { Anchor } from "./tasks-types";
import { and, asc, desc, eq, inArray, isNull, like, notInArray, sql } from "drizzle-orm";

export function getTask(db: Database, taskId: string): Task | null {
  const row = orm(db).select().from(tasks).where(eq(tasks.id, taskId)).get();
  return row ?? null;
}

export function requireTask(db: Database, taskId: string): Task {
  const task = getTask(db, taskId);
  if (!task) throw new Error(`no such task: ${taskId}`);
  return task;
}

export function requireTaskFor(db: Database, identityId: string, taskId: string): Task {
  const task = getTask(db, taskId);
  if (!task || task.identityId !== identityId) throw new Error(`no such task: ${taskId}`);
  return task;
}

export function nextTaskId(db: Database): string {
  const row = orm(db)
    .select({ n: sql<number | null>`MAX(CAST(SUBSTR(${tasks.id}, 3) AS INTEGER))` })
    .from(tasks)
    .where(like(tasks.id, "T-%"))
    .get();
  return `T-${(row?.n ?? 0) + 1}`;
}

export function ledgerView(
  db: Database,
  identityId: string,
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
    .limit(10)
    .all();
  return {
    open: openRows,
    recentTerminals: terminalRows,
  };
}

export function liveTaskStatusAt(
  db: Database,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): "open" | "active" | "waiting" | null {
  const row = orm(db)
    .select({ status: tasks.status })
    .from(tasks)
    .where(
      and(
        eq(tasks.identityId, identityId),
        eq(tasks.homeVenueId, venueId),
        threadRootId ? eq(tasks.homeThreadRootId, threadRootId) : isNull(tasks.homeThreadRootId),
        inArray(tasks.status, ["open", "active", "waiting"]),
      ),
    )
    .orderBy(desc(tasks.rowid))
    .limit(1)
    .get();
  return row?.status === "open" || row?.status === "active" || row?.status === "waiting"
    ? row.status
    : null;
}

export function liveExecutionId(db: Database, taskId: string): string | null {
  const row = orm(db)
    .select({ id: executions.id })
    .from(executions)
    .where(and(eq(executions.taskId, taskId), eq(executions.status, "running")))
    .get();
  return row?.id ?? null;
}

export function createTask(
  db: Database,
  clock: Clock,
  params: {
    id: string;
    identityId: string;
    title: string;
    spec: string;
    sponsorId: string;
    homeAnchor: Anchor;
    originEventId: string;
    tier?: Task["tier"] | undefined;
  },
): Task {
  const now = clock();
  orm(db)
    .insert(tasks)
    .values({
      id: params.id,
      identityId: params.identityId,
      title: params.title,
      spec: params.spec,
      status: "open",
      waitingOn: null,
      sponsorId: params.sponsorId,
      homeVenueId: params.homeAnchor.venueId,
      homeThreadRootId: params.homeAnchor.threadRootId,
      originEventId: params.originEventId,
      wakeAt: null,
      tier: params.tier ?? "high",
      terminalReport: null,
      createdAt: now,
      updatedAt: now,
      openedAt: now,
      consecutiveInterruptions: 0,
    })
    .run();
  writeAudit(db, now, params.identityId, {
    kind: "task_created",
    payload: {
      taskId: params.id,
      title: params.title,
    },
  });
  return requireTask(db, params.id);
}
