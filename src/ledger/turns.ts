import type { TurnEffect } from "../schemas/effects";

import type { Database } from "bun:sqlite";
import { desc, eq } from "drizzle-orm";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";
import { orm } from "./db";
import { executions, turns, type TurnKind, type Turn, type TurnStatus } from "./schema";
import type { Anchor } from "./tasks-types";

export function recordTurn(
  db: Database,
  clock: Clock,
  params: {
    id: string;
    identityId: string;
    kind: TurnKind;
    executionId?: string | null;
    anchor?: Anchor | null;
    status: TurnStatus;
    effects: TurnEffect[];
    startedAt: string;
  },
): Turn {
  const now = clock();
  writeAudit(db, params.startedAt, params.identityId, {
    kind: "turn_started",
    payload: {
      turnId: params.id,
      kind: params.kind,
    },
  });
  const turn = orm(db)
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
      startedAt: params.startedAt,
      endedAt: now,
    })
    .returning()
    .get();
  writeAudit(db, now, params.identityId, {
    kind: "turn_ended",
    payload: {
      turnId: params.id,
      status: params.status,
    },
  });
  return turn;
}

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
