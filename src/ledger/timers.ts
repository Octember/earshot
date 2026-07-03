// SPEC §13 — durable timers. This module owns only the timers table; it has no knowledge of the
// task state machine (that lives in tasks.ts, which schedules timers through this module).
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";

export type TimerKind = "task_wake" | "nudge" | "park" | "ambient_tick" | "distillation" | "recurrence";

export interface TimerRow {
  id: string;
  kind: TimerKind;
  identityId: string;
  subjectId: string | null;
  dueAt: string;
  firedAt: string | null;
}

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
  db.query(
    "INSERT OR IGNORE INTO timers (id, kind, identity_id, subject_id, due_at, fired_at) VALUES (?, ?, ?, ?, ?, NULL)",
  ).run(params.id, params.kind, params.identityId, params.subjectId ?? null, params.dueAt);
}

interface Row {
  id: string;
  kind: TimerKind;
  identity_id: string;
  subject_id: string | null;
  due_at: string;
  fired_at: string | null;
}

function rowToTimer(row: Row): TimerRow {
  return {
    id: row.id,
    kind: row.kind,
    identityId: row.identity_id,
    subjectId: row.subject_id,
    dueAt: row.due_at,
    firedAt: row.fired_at,
  };
}

// Due-time order, overdue-safe: whatever "now" is (including well past due_at after a long
// restart), every unfired timer at or before it comes back in due_at order (SPEC §13).
export function listDueTimers(db: Database, clock: Clock): TimerRow[] {
  const now = clock();
  const rows = db
    .query("SELECT * FROM timers WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at ASC, id ASC")
    .all(now) as Row[];
  return rows.map(rowToTimer);
}

export function markTimerFired(db: Database, clock: Clock, timerId: string): void {
  db.query("UPDATE timers SET fired_at = ? WHERE id = ?").run(clock(), timerId);
}
