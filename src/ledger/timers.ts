// SPEC §13 — durable timers. This module owns only the timers table; it has no knowledge of the
// task state machine (that lives in tasks.ts, which schedules timers through this module).
import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { timers, type Timer, type TimerKind } from "./schema";

export type { Timer as TimerRow, TimerKind };

export interface ScheduleTimerParams {
  id: string;
  kind: TimerKind;
  identityId: string;
  subjectId?: string | null;
  dueAt: string;
}

// Idempotent: scheduling the same timer id twice (e.g. a redelivered event) is a no-op, matching
// SPEC §13's "handlers MUST be idempotent."
export function scheduleTimer(db: Database, params: ScheduleTimerParams): void {
  orm(db)
    .insert(timers)
    .values({
      id: params.id,
      kind: params.kind,
      identityId: params.identityId,
      subjectId: params.subjectId ?? null,
      dueAt: params.dueAt,
      firedAt: null,
    })
    .onConflictDoNothing()
    .run();
}

// Due-time order, overdue-safe: whatever "now" is (including well past due_at after a long
// restart), every unfired timer at or before it comes back in due_at order (SPEC §13).
export function listDueTimers(db: Database, clock: Clock): Timer[] {
  return orm(db)
    .select()
    .from(timers)
    .where(and(isNull(timers.firedAt), lte(timers.dueAt, clock())))
    .orderBy(asc(timers.dueAt), asc(timers.id))
    .all();
}

export function markTimerFired(db: Database, clock: Clock, timerId: string): void {
  orm(db).update(timers).set({ firedAt: clock() }).where(eq(timers.id, timerId)).run();
}
