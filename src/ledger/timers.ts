import type { Database } from "bun:sqlite";
import { orm } from "./db";
import { timers, type TimerKind } from "./schema";

export function scheduleTimer(
  db: Database,
  params: {
    id: string;
    kind: TimerKind;
    identityId: string;
    subjectId?: string | null;
    dueAt: string;
  },
): void {
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
