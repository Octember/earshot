// SPEC §15 — the operator status surface (RECOMMENDED, OPTIONAL). A read-only runtime snapshot
// derived entirely from the ledger — nothing new is persisted. Answers "what's running / waiting /
// what did we spend" per identity, kept minimal per §2.2 (no rich web UI).
import type { Database } from "bun:sqlite";
import type { Clock } from "./ledger/clock";
import { identitySpendThisMonth, globalSpendThisMonth } from "./policy/budget";
import { many, one } from "./ledger/db";

export interface IdentityStatus {
  identityId: string;
  open: number;
  active: number;
  running: number; // live executions (should equal `active`, but counted independently as a cross-check)
  waitingHuman: number;
  waitingTimer: number;
  parked: number;
  spendThisMonth: number;
}

export interface RuntimeSnapshot {
  at: string;
  identities: IdentityStatus[];
  globalSpendThisMonth: number;
  timersDue: number;
  timersPending: number;
}

export function runtimeSnapshot(db: Database, clock: Clock, timezone: string): RuntimeSnapshot {
  const now = clock();
  const idRows = many<{ identity_id: string }>(db, "SELECT DISTINCT identity_id FROM tasks ORDER BY identity_id");

  const identities: IdentityStatus[] = idRows.map(({ identity_id }) => {
    const count = (sql: string, ...params: import("bun:sqlite").SQLQueryBindings[]) =>
      one<{ c: number }>(db, sql, identity_id, ...params)?.c ?? 0;
    return {
      identityId: identity_id,
      open: count("SELECT COUNT(*) as c FROM tasks WHERE identity_id = ? AND status = 'open'"),
      active: count("SELECT COUNT(*) as c FROM tasks WHERE identity_id = ? AND status = 'active'"),
      running: one<{ c: number }>(db, "SELECT COUNT(*) as c FROM executions e JOIN tasks t ON t.id = e.task_id WHERE e.status = 'running' AND t.identity_id = ?", identity_id)?.c ?? 0,
      waitingHuman: count("SELECT COUNT(*) as c FROM tasks WHERE identity_id = ? AND status = 'waiting' AND waiting_on = 'human'"),
      waitingTimer: count("SELECT COUNT(*) as c FROM tasks WHERE identity_id = ? AND status = 'waiting' AND waiting_on = 'timer'"),
      parked: count("SELECT COUNT(*) as c FROM tasks WHERE identity_id = ? AND status = 'parked'"),
      spendThisMonth: identitySpendThisMonth(db, clock, identity_id, timezone),
    };
  });

  const timersDue = one<{ c: number }>(db, "SELECT COUNT(*) as c FROM timers WHERE fired_at IS NULL AND due_at <= ?", now)?.c ?? 0;
  const timersPending = one<{ c: number }>(db, "SELECT COUNT(*) as c FROM timers WHERE fired_at IS NULL AND due_at > ?", now)?.c ?? 0;

  return {
    at: now,
    identities,
    globalSpendThisMonth: globalSpendThisMonth(db, clock, timezone),
    timersDue,
    timersPending,
  };
}
