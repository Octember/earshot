import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { acts } from "./schema";
import { rootKey } from "./conversations-stance";

export function recordAct(
  db: Database,
  clock: Clock,
  identityId: string,
  wakeId: string,
  act: {
    kind: "posted" | "reacted";
    venueId: string;
    threadRootId: string | null;
    ts: string | null;
    text: string;
  },
): { inserted: boolean; actKey: string } {
  const actKey = `${act.kind}:${act.venueId}:${rootKey(act.threadRootId)}:${act.text}:${act.kind === "reacted" ? act.ts : ""}`;
  const result = orm(db)
    .insert(acts)
    .values({
      wakeId,
      actKey,
      identityId,
      kind: act.kind,
      venueId: act.venueId,
      threadRootId: act.threadRootId,
      ts: act.ts,
      text: act.text,
      at: clock(),
    })
    .onConflictDoNothing()
    .returning({ id: acts.id })
    .get();
  return { inserted: result != null, actKey };
}

export function setActTs(
  db: Database,
  wakeId: string,
  actKey: string,
  ts: string,
  threadRootId?: string | null,
): void {
  orm(db)
    .update(acts)
    .set({ ts, ...(threadRootId !== undefined ? { threadRootId } : {}) })
    .where(and(eq(acts.wakeId, wakeId), eq(acts.actKey, actKey)))
    .run();
}

export function deleteAct(db: Database, wakeId: string, actKey: string): void {
  orm(db)
    .delete(acts)
    .where(and(eq(acts.wakeId, wakeId), eq(acts.actKey, actKey)))
    .run();
}
