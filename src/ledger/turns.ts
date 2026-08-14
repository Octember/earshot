// SPEC §4.1.6 — one bounded agent invocation. Turns are recorded once complete (there is no
// "running" turn row — a live turn's existence lives in the caller's process, not the ledger);
// audit carries both the start and end events regardless.
import type { Database } from "bun:sqlite";
import { asString, isRecord, parseJson } from "../guard";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import { many, one } from "./db";
import type { Anchor } from "./tasks";

// The ledger accepts the live kinds (resident/execution_step/attention) plus the pre-collapse
// kinds, which survive as historical rows (turns.kind CHECK, schema v11).
export type TurnKind = "resident" | "execution_step" | "attention" | "interactive" | "ambient" | "distillation";
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

function asUnknownArray(text: string): unknown[] {
  const v = parseJson(text);
  return Array.isArray(v) ? v : [];
}

function rowToTurn(row: Row): Turn {
  return {
    id: row.id,
    identityId: row.identity_id,
    kind: row.kind,
    executionId: row.execution_id,
    anchor: row.venue_id ? { venueId: row.venue_id, threadRootId: row.thread_root_id } : null,
    status: row.status,
    effects: asUnknownArray(row.effects),
    spendAmount: row.spend_amount,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function getTurn(db: Database, turnId: string): Turn | null {
  const row = one<Row>(db, "SELECT * FROM turns WHERE id = ?", turnId);
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

// Her own voice, as the ear and the next wake's digest see it. Her posts never enter the events
// stream (§10.5 self-ignore) and reactions are not messages at all, so without this the ear
// judges "did she answer?" blind — observed live as debts reopened against answers it never
// saw. Step-backs ride too: a wake is a fresh session, and one that doesn't know she just left
// a conversation walks back into it (live 2026-08-10). All recovered from resident turn
// effects, the same ledger the optimistic close reads.
export interface OutboundEffect {
  kind: "posted" | "reacted" | "stepped_back";
  venueId: string;
  threadRootId: string | null; // posted/stepped_back: the thread
  ts: string | null; // reacted: the message she reacted to
  emoji: string | null;
  text: string | null;
  why: string | null; // stepped_back: her recorded reason
}

export function lastTurnStartedAt(db: Database, identityId: string, kind: TurnKind): string | null {
  const row = one<{ at: string | null }>(db, "SELECT MAX(started_at) AS at FROM turns WHERE identity_id = ? AND kind = ?", identityId, kind);
  return row?.at ?? null;
}

export function outboundEffectsSince(db: Database, identityId: string, sinceIso: string): OutboundEffect[] {
  const rows = many<{ effects: string }>(
    db,
    "SELECT effects FROM turns WHERE identity_id = ? AND kind = 'resident' AND started_at >= ? ORDER BY started_at",
    identityId,
    sinceIso,
  );
  const out: OutboundEffect[] = [];
  for (const row of rows) {
    const effects = parseJson(row.effects);
    if (!Array.isArray(effects)) continue;
    for (const item of effects) {
      if (!isRecord(item)) continue;
      const anchor = isRecord(item.anchor) ? item.anchor : {};
      if (item.kind === "posted") {
        out.push({
          kind: "posted",
          venueId: asString(anchor.venueId),
          threadRootId: typeof anchor.threadRootId === "string" ? anchor.threadRootId : null,
          ts: null,
          emoji: null,
          text: typeof item.text === "string" ? item.text : null,
          why: null,
        });
      } else if (item.kind === "reacted") {
        out.push({
          kind: "reacted",
          venueId: asString(item.venueId),
          threadRootId: null,
          ts: typeof item.ts === "string" ? item.ts : null,
          emoji: typeof item.emoji === "string" ? item.emoji : null,
          text: null,
          why: null,
        });
      } else if (item.kind === "stepped_back") {
        out.push({
          kind: "stepped_back",
          venueId: asString(item.venueId),
          threadRootId: typeof item.threadRootId === "string" ? item.threadRootId : null,
          ts: null,
          emoji: null,
          text: null,
          why: typeof item.why === "string" ? item.why : null,
        });
      }
    }
  }
  return out;
}

// The worker's task_ask question, recovered from its turn effects so the resident mind
// can put the actual question to the room (the ask itself posts nothing).
export function lastAskQuestion(db: Database, taskId: string): string | null {
  const rows = many<{ effects: string }>(
    db,
    `SELECT t.effects FROM turns t JOIN executions e ON t.execution_id = e.id
       WHERE e.task_id = ? ORDER BY t.started_at DESC LIMIT 10`,
    taskId,
  );
  for (const row of rows) {
    try {
      const effects = parseJson(row.effects);
      if (!Array.isArray(effects)) continue;
      const ask = effects.toReversed().find((e) => isRecord(e) && e.kind === "task_asked" && typeof e.question === "string");
      if (isRecord(ask) && typeof ask.question === "string") return ask.question;
    } catch {
      // a malformed effects row is a recording bug, not a reason to fail delivery
    }
  }
  return null;
}
