// Read-only runtime snapshot from the ledger.
import type { Database } from "bun:sqlite";
import { and, count, eq, gt, isNull, lte, type SQL } from "drizzle-orm";
import type { Clock } from "./ledger/clock";
import { identitySpendThisMonth, globalSpendThisMonth } from "./policy/budget";
import { orm } from "./ledger/db";
import { executions, tasks, timers } from "./ledger/schema";

function taskCount(db: Database, identityId: string, ...conds: SQL[]): number {
  return (
    orm(db)
      .select({ c: count() })
      .from(tasks)
      .where(and(eq(tasks.identityId, identityId), ...conds))
      .get()?.c ?? 0
  );
}

export function runtimeSnapshot(db: Database, clock: Clock, timezone: string) {
  const now = clock();
  const idRows = orm(db)
    .selectDistinct({ identityId: tasks.identityId })
    .from(tasks)
    .orderBy(tasks.identityId)
    .all();

  const identities = idRows.map(({ identityId }) => ({
    identityId,
    open: taskCount(db, identityId, eq(tasks.status, "open")),
    active: taskCount(db, identityId, eq(tasks.status, "active")),
    running:
      orm(db)
        .select({ c: count() })
        .from(executions)
        .innerJoin(tasks, eq(tasks.id, executions.taskId))
        .where(and(eq(executions.status, "running"), eq(tasks.identityId, identityId)))
        .get()?.c ?? 0,
    waitingHuman: taskCount(
      db,
      identityId,
      eq(tasks.status, "waiting"),
      eq(tasks.waitingOn, "human"),
    ),
    waitingTimer: taskCount(
      db,
      identityId,
      eq(tasks.status, "waiting"),
      eq(tasks.waitingOn, "timer"),
    ),
    parked: taskCount(db, identityId, eq(tasks.status, "parked")),
    spendThisMonth: identitySpendThisMonth(db, clock, identityId, timezone),
  }));

  const timersDue =
    orm(db)
      .select({ c: count() })
      .from(timers)
      .where(and(isNull(timers.firedAt), lte(timers.dueAt, now)))
      .get()?.c ?? 0;
  const timersPending =
    orm(db)
      .select({ c: count() })
      .from(timers)
      .where(and(isNull(timers.firedAt), gt(timers.dueAt, now)))
      .get()?.c ?? 0;

  return {
    at: now,
    identities,
    globalSpendThisMonth: globalSpendThisMonth(db, clock, timezone),
    timersDue,
    timersPending,
  };
}
