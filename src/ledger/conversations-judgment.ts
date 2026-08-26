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
import { stringList } from "./conversations-util";

const HOLD_WHY_KEEP = 4; // bounded history — never a single latest-wins why (a stale one would render as live fact)

// Hold: durable "nothing needed"; why history is bounded.
export function recordHold(
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
    .set({
      holds: sql`${conversations.holds} + 1`,
      holdWhys: sql`json_insert(CASE WHEN json_array_length(${conversations.holdWhys}) >= ${HOLD_WHY_KEEP} THEN json_remove(${conversations.holdWhys}, '$[0]') ELSE ${conversations.holdWhys} END, '$[#]', ${why})`,
    })
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
      .select({
        holds: conversations.holds,
        holdWhys: conversations.holdWhys,
        wakeWhy: conversations.wakeWhy,
      })
      .from(conversations)
      .where(convoEq(identityId, key.venueId, key.threadRootId))
      .get() ?? { holds: 0, holdWhys: [] as string[], wakeWhy: null };
    out = { ...key, holds: row.holds, holdWhys: stringList(row.holdWhys), wakeWhy: row.wakeWhy };
    // Delivery advances only its watermark; judged cursor may trail for after-the-fact bookkeeping.
    orm(db)
      .update(conversations)
      .set({
        holds: 0,
        holdWhys: [],
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
    .select({
      holds: conversations.holds,
      holdWhys: conversations.holdWhys,
      wakeWhy: conversations.wakeWhy,
    })
    .from(conversations)
    .where(convoEq(identityId, venueId, threadRootId))
    .get();
  return row
    ? {
        venueId,
        threadRootId,
        holds: row.holds,
        holdWhys: stringList(row.holdWhys),
        wakeWhy: row.wakeWhy,
      }
    : null;
}
