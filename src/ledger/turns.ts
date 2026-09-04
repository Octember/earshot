import type { TurnEffect } from "../schemas/effects";

import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { orm } from "./db";
import { turns, type TurnKind, type Turn, type TurnStatus } from "./schema";

export function recordTurn(
  db: Database,
  clock: Clock,
  params: {
    id: string;
    identityId: string;
    kind: TurnKind;
    taskId?: string | null;
    status: TurnStatus;
    effects: TurnEffect[];
    startedAt: string;
  },
): Turn {
  const now = clock();
  const turn = orm(db)
    .insert(turns)
    .values({
      id: params.id,
      identityId: params.identityId,
      kind: params.kind,
      taskId: params.taskId ?? null,
      status: params.status,
      effects: params.effects,
      startedAt: params.startedAt,
      endedAt: now,
    })
    .returning()
    .get();
  return turn;
}
