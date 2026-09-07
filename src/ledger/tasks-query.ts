import { now } from "./clock";
import type { Ledger } from "./db";
import { tasks, type Task } from "./schema";
import { and, asc, desc, eq, gt, isNull, like, ne, or, sql } from "drizzle-orm";

export function getTask(db: Ledger, taskId: string): Task | null {
  return db.select().from(tasks).where(eq(tasks.id, taskId)).get() ?? null;
}

export function requireTask(db: Ledger, taskId: string, identityId?: string): Task {
  const task = getTask(db, taskId);
  if (!task || (identityId && task.identityId !== identityId))
    throw new Error(`no such task: ${taskId}`);
  return task;
}

export function ledgerView(db: Ledger, identityId: string) {
  return {
    open: db
      .select()
      .from(tasks)
      .where(and(eq(tasks.identityId, identityId), ne(tasks.status, "done")))
      .orderBy(asc(tasks.openedAt))
      .all(),
    recentTerminals: db
      .select()
      .from(tasks)
      .where(and(eq(tasks.identityId, identityId), eq(tasks.status, "done")))
      .orderBy(desc(tasks.updatedAt))
      .limit(10)
      .all(),
  };
}

export function createTask(
  db: Ledger,
  params: {
    identityId: string;
    title: string;
    spec: string;
    channel: string;
    thread_ts?: string | undefined;
    tier?: Task["tier"] | undefined;
  },
): Task {
  const last = db
    .select({ n: sql<number | null>`MAX(CAST(SUBSTR(${tasks.id}, 3) AS INTEGER))` })
    .from(tasks)
    .where(like(tasks.id, "T-%"))
    .get();
  const at = now();
  return db
    .insert(tasks)
    .values({
      id: `T-${(last?.n ?? 0) + 1}`,
      identityId: params.identityId,
      title: params.title,
      spec: params.spec,
      status: "open",
      homeVenueId: params.channel,
      homeThreadRootId: params.thread_ts ?? null,
      ...(params.tier ? { tier: params.tier } : {}),
      updatedAt: at,
      openedAt: at,
    })
    .returning()
    .get();
}

export function unseenTaskUpdates(db: Ledger, identityId: string): Task[] {
  return db
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

export function markTasksSeen(db: Ledger, updates: Task[]): void {
  for (const task of updates)
    db.update(tasks)
      .set({ seenAt: task.updatedAt })
      .where(and(eq(tasks.id, task.id), eq(tasks.updatedAt, task.updatedAt)))
      .run();
}
