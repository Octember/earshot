import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { orm } from "./db";
import { tasks, type Task } from "./schema";
import type { Anchor } from "./tasks-types";
import { and, asc, desc, eq, gt, isNull, like, ne, or, sql } from "drizzle-orm";

export function getTask(db: Database, taskId: string): Task | null {
  const row = orm(db).select().from(tasks).where(eq(tasks.id, taskId)).get();
  return row ?? null;
}

export function requireTask(db: Database, taskId: string, identityId?: string): Task {
  const task = getTask(db, taskId);
  if (!task || (identityId && task.identityId !== identityId))
    throw new Error(`no such task: ${taskId}`);
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
    .where(and(eq(tasks.identityId, identityId), ne(tasks.status, "done")))
    .orderBy(asc(tasks.openedAt))
    .all();
  const terminalRows = orm(db)
    .select()
    .from(tasks)
    .where(and(eq(tasks.identityId, identityId), eq(tasks.status, "done")))
    .orderBy(desc(tasks.updatedAt))
    .limit(10)
    .all();
  return {
    open: openRows,
    recentTerminals: terminalRows,
  };
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
  return orm(db)
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
      waitingWhy: null,
      wakeAt: null,
      outcome: null,
      report: null,
      seenAt: null,
      ...(params.tier ? { tier: params.tier } : {}),
      createdAt: now,
      updatedAt: now,
      openedAt: now,
    })
    .returning()
    .get();
}

export function unseenTaskUpdates(db: Database, identityId: string): Task[] {
  return orm(db)
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.identityId, identityId),
        or(eq(tasks.status, "done"), eq(tasks.waitingOn, "human")),
        or(isNull(tasks.seenAt), gt(tasks.updatedAt, tasks.seenAt)),
      ),
    )
    .orderBy(asc(tasks.updatedAt))
    .all();
}

export function markTasksSeen(db: Database, updates: Task[]): void {
  for (const task of updates)
    orm(db)
      .update(tasks)
      .set({ seenAt: task.updatedAt })
      .where(and(eq(tasks.id, task.id), eq(tasks.updatedAt, task.updatedAt)))
      .run();
}
