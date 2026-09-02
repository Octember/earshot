import type { Database } from "bun:sqlite";
import { sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { conversations } from "./schema";
import {
  convoEq,
  ensureConversation,
  type ConversationJudgment,
  type ConversationKey,
} from "./conversations-stance";

// Hold: durable "nothing needed" count; the why lives in the ear turn's effects.
export function recordHold(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  orm(db)
    .update(conversations)
    .set({ holds: sql`${conversations.holds} + 1` })
    .where(convoEq(identityId, venueId, threadRootId))
    .run();
}

// Attention-pass wake why — first read of the conversation, durable.
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

// Deliver messages + consume judgment in one transaction.
export function consumeJudgment(
  db: Database,
  clock: Clock,
  identityId: string,
  key: ConversationKey,
  deliveredRowid: number,
): ConversationJudgment {
  let out: ConversationJudgment;
  db.transaction(() => {
    ensureConversation(db, clock, identityId, key.venueId, key.threadRootId);
    const row = orm(db)
      .select({ holds: conversations.holds, wakeWhy: conversations.wakeWhy })
      .from(conversations)
      .where(convoEq(identityId, key.venueId, key.threadRootId))
      .get() ?? { holds: 0, wakeWhy: null };
    out = { ...key, holds: row.holds, wakeWhy: row.wakeWhy };
    // Delivery advances only its watermark; judged cursor may trail for after-the-fact bookkeeping.
    orm(db)
      .update(conversations)
      .set({
        holds: 0,
        wakeWhy: null,
        deliveredRowid: sql`max(${conversations.deliveredRowid}, ${deliveredRowid})`,
      })
      .where(convoEq(identityId, key.venueId, key.threadRootId))
      .run();
  })();
  return out!;
}

export function getConversationJudgment(
  db: Database,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): ConversationJudgment | null {
  const row = orm(db)
    .select({ holds: conversations.holds, wakeWhy: conversations.wakeWhy })
    .from(conversations)
    .where(convoEq(identityId, venueId, threadRootId))
    .get();
  return row ? { venueId, threadRootId, holds: row.holds, wakeWhy: row.wakeWhy } : null;
}
