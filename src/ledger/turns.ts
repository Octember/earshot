import type { TurnEffect } from "../schemas/effects";
// Turns recorded on completion; audit carries start+end.
import type { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import { orm } from "./db";
import { executions, turns, type TurnKind, type Turn, type TurnStatus } from "./schema";
import type { Anchor } from "./tasks-types";

export interface RecordTurnParams {
  id: string;
  identityId: string;
  kind: TurnKind;
  executionId?: string | null;
  anchor?: Anchor | null;
  status: TurnStatus;
  effects: TurnEffect[];
  spendAmount: number;
  startedAt: string;
}

export function getTurn(db: Database, turnId: string): Turn | null {
  const row = orm(db).select().from(turns).where(eq(turns.id, turnId)).get();
  return row ?? null;
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
    const ask = row.effects.toReversed().find((effect) => effect.kind === "task_asked");
    if (ask) return ask.question;
  }
  return null;
}
