// Durable timers table (no task state machine knowledge).
import type { Database } from "bun:sqlite";
import { orm } from "./db";
import { timers, type TimerKind } from "./schema";

interface ScheduleTimerParams {
  id: string;
  kind: TimerKind;
  identityId: string;
  subjectId?: string | null;
  dueAt: string;
}

// Same timer id twice is a no-op.
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

// Unfired timers with due_at <= now, due-time order.
