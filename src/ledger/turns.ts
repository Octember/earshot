// SPEC §4.1.6 — one bounded agent invocation. Turns are recorded once complete (there is no
// "running" turn row — a live turn's existence lives in the caller's process, not the ledger);
// audit carries both the start and end events regardless.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import type { Anchor } from "./tasks";

export type TurnKind = "interactive" | "execution_step" | "ambient" | "distillation";
export type TurnStatus = "succeeded" | "failed" | "timed_out" | "budget_denied";

export interface Turn {
  id: string;
  identityId: string;
  kind: TurnKind;
  executionId: string | null;
  anchor: Anchor | null;
  status: TurnStatus;
  effects: unknown[];
  spendAmount: number;
  startedAt: string;
  endedAt: string | null;
}

export interface RecordTurnParams {
  id: string;
  identityId: string;
  kind: TurnKind;
  executionId?: string | null;
  anchor?: Anchor | null;
  status: TurnStatus;
  effects: unknown[];
  spendAmount: number;
  startedAt: string;
}

interface Row {
  id: string;
  identity_id: string;
  kind: TurnKind;
  execution_id: string | null;
  venue_id: string | null;
  thread_root_id: string | null;
  status: TurnStatus;
  effects: string;
  spend_amount: number;
  started_at: string;
  ended_at: string | null;
}

function rowToTurn(row: Row): Turn {
  return {
    id: row.id,
    identityId: row.identity_id,
    kind: row.kind,
    executionId: row.execution_id,
    anchor: row.venue_id ? { venueId: row.venue_id, threadRootId: row.thread_root_id } : null,
    status: row.status,
    effects: JSON.parse(row.effects),
    spendAmount: row.spend_amount,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function getTurn(db: Database, turnId: string): Turn | null {
  const row = db.query("SELECT * FROM turns WHERE id = ?").get(turnId) as Row | null;
  return row ? rowToTurn(row) : null;
}

export function recordTurn(db: Database, clock: Clock, params: RecordTurnParams): Turn {
  const now = clock();
  writeAudit(db, params.startedAt, params.identityId, "turn_started", { turnId: params.id, kind: params.kind });
  db.query(
    `INSERT INTO turns (id, identity_id, kind, execution_id, venue_id, thread_root_id, status, effects,
       spend_amount, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.id,
    params.identityId,
    params.kind,
    params.executionId ?? null,
    params.anchor?.venueId ?? null,
    params.anchor?.threadRootId ?? null,
    params.status,
    JSON.stringify(params.effects),
    params.spendAmount,
    params.startedAt,
    now,
  );
  writeAudit(db, now, params.identityId, "turn_ended", { turnId: params.id, status: params.status, spendAmount: params.spendAmount });
  return getTurn(db, params.id)!;
}
