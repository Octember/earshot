// Turns recorded on completion; audit carries start+end.
import type { Database } from "bun:sqlite";
import { and, desc, eq, gte } from "drizzle-orm";
import { parseOutboundEffect, parseTaskAskedQuestion } from "../schemas/effects";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import { orm } from "./db";
import { executions, turns, type TurnKind, type TurnRow, type TurnStatus } from "./schema";
import type { Anchor } from "./tasks";

export type { TurnKind, TurnStatus };

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

function rowToTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    identityId: row.identityId,
    kind: row.kind,
    executionId: row.executionId,
    anchor: row.venueId ? { venueId: row.venueId, threadRootId: row.threadRootId } : null,
    status: row.status,
    effects: Array.isArray(row.effects) ? row.effects : [],
    spendAmount: row.spendAmount,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
  };
}

export function getTurn(db: Database, turnId: string): Turn | null {
  const row = orm(db).select().from(turns).where(eq(turns.id, turnId)).get();
  return row ? rowToTurn(row) : null;
}

export function recordTurn(db: Database, clock: Clock, params: RecordTurnParams): Turn {
  const now = clock();
  writeAudit(db, params.startedAt, params.identityId, "turn_started", {
    turnId: params.id,
    kind: params.kind,
  });
  orm(db)
    .insert(turns)
    .values({
      id: params.id,
      identityId: params.identityId,
      kind: params.kind,
      executionId: params.executionId ?? null,
      venueId: params.anchor?.venueId ?? null,
      threadRootId: params.anchor?.threadRootId ?? null,
      status: params.status,
      effects: params.effects,
      spendAmount: params.spendAmount,
      startedAt: params.startedAt,
      endedAt: now,
    })
    .run();
  writeAudit(db, now, params.identityId, "turn_ended", {
    turnId: params.id,
    status: params.status,
    spendAmount: params.spendAmount,
  });
  return getTurn(db, params.id)!;
}

// Outbound acts for digests (posts are not events).
export interface OutboundEffect {
  kind: "posted" | "reacted" | "stepped_back";
  venueId: string;
  threadRootId: string | null; // posted/stepped_back: the thread
  ts: string | null; // reacted: target message ts
  emoji: string | null;
  text: string | null;
  why: string | null; // stepped_back: recorded leave reason
}

export function outboundEffectsSince(
  db: Database,
  identityId: string,
  sinceIso: string,
): OutboundEffect[] {
  const rows = orm(db)
    .select({ effects: turns.effects })
    .from(turns)
    .where(
      and(
        eq(turns.identityId, identityId),
        eq(turns.kind, "resident"),
        gte(turns.startedAt, sinceIso),
      ),
    )
    .orderBy(turns.startedAt)
    .all();
  const out: OutboundEffect[] = [];
  for (const row of rows) {
    const effects = Array.isArray(row.effects) ? row.effects : [];
    for (const item of effects) {
      const outbound = parseOutboundEffect(item);
      if (outbound) out.push(outbound);
    }
  }
  return out;
}

// task_ask question from turn effects (ask itself posts nothing).
export function lastAskQuestion(db: Database, taskId: string): string | null {
  const rows = orm(db)
    .select({ effects: turns.effects })
    .from(turns)
    .innerJoin(executions, eq(turns.executionId, executions.id))
    .where(eq(executions.taskId, taskId))
    .orderBy(desc(turns.startedAt))
    .limit(10)
    .all();
  for (const row of rows) {
    const effects = Array.isArray(row.effects) ? row.effects : [];
    const ask = effects
      .toReversed()
      .map((effect) => parseTaskAskedQuestion(effect))
      .find((question) => question !== null);
    if (ask) return ask;
  }
  return null;
}
