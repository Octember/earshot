import type { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { conversations } from "./schema";
import { convoEq, ensureConversation } from "./conversations-stance";
import type { Anchor } from "./tasks-types";

export function recordWakeWhy(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
  why: string,
): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  orm(db)
    .update(conversations)
    .set({ wakeWhy: why })
    .where(convoEq(identityId, venueId, threadRootId))
    .run();
}

export function wakeWhyOf(db: Database, identityId: string, key: Anchor): string | null {
  return (
    orm(db)
      .select({ wakeWhy: conversations.wakeWhy })
      .from(conversations)
      .where(convoEq(identityId, key.venueId, key.threadRootId))
      .get()?.wakeWhy ?? null
  );
}

export function deliverConversation(
  db: Database,
  clock: Clock,
  identityId: string,
  key: Anchor,
  deliveredRowid: number,
): void {
  ensureConversation(db, clock, identityId, key.venueId, key.threadRootId);
  orm(db)
    .update(conversations)
    .set({
      wakeWhy: null,
      deliveredRowid: sql`max(${conversations.deliveredRowid}, ${deliveredRowid})`,
    })
    .where(convoEq(identityId, key.venueId, key.threadRootId))
    .run();
}
