import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNotNull, isNull, max, or, sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { conversations, events } from "./schema";
import type { InboxMessage } from "./inbox";
import {
  convoEq,
  convoKey,
  ensureConversation,
  stanceOf,
  type ConversationKey,
  type PendingConversation,
} from "./conversations-stance";
import {
  convoJoin,
  DELIVERABLE_KINDS,
  eventCols,
  messagesOf,
  outStanceExceptions,
} from "./conversations-util";

// Group undelivered by conversation; out-stance holds observed chatter.
function groupByConversation(
  db: Database,
  identityId: string,
  messages: InboxMessage[],
): PendingConversation[] {
  const grouped = new Map<string, PendingConversation>();
  for (const message of messages) {
    const key = convoKey(message.venueId!, message.threadRootId);
    let group = grouped.get(key);
    if (!group) {
      group = {
        venueId: message.venueId!,
        threadRootId: message.threadRootId,
        stance: stanceOf(db, identityId, message.venueId!, message.threadRootId),
        messages: [],
      };
      grouped.set(key, group);
    }
    group.messages.push(message);
  }
  return [...grouped.values()];
}

export function pendingConversations(
  db: Database,
  identityId: string,
  limit = 200,
): PendingConversation[] {
  const rows = orm(db)
    .select(eventCols)
    .from(events)
    .leftJoin(conversations, convoJoin())
    .where(
      and(
        eq(events.identityId, identityId),
        inArray(events.kind, DELIVERABLE_KINDS),
        isNotNull(events.venueId),
        sql`${events}.rowid > ifnull(${conversations.deliveredRowid}, 0)`,
        outStanceExceptions(),
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .limit(limit)
    .all();
  const direct = orm(db)
    .select(eventCols)
    .from(events)
    .leftJoin(conversations, convoJoin())
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.kind, "addressed_message"),
        isNotNull(events.venueId),
        sql`${events}.rowid > ifnull(${conversations.deliveredRowid}, 0)`,
        sql`json_extract(${events.payload}, '$.addressMode') IN ('mention', 'dm')`,
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .all();
  const seen = new Set(rows.map((row) => row.rowid));
  const merged = [...rows, ...direct.filter((row) => !seen.has(row.rowid))].toSorted(
    (a, b) => a.rowid - b.rowid,
  );
  return groupByConversation(db, identityId, messagesOf(merged));
}

export function hasUndelivered(db: Database, identityId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(events)
      .leftJoin(conversations, convoJoin())
      .where(
        and(
          eq(events.identityId, identityId),
          inArray(events.kind, DELIVERABLE_KINDS),
          isNotNull(events.venueId),
          sql`${events}.rowid > ifnull(${conversations.deliveredRowid}, 0)`,
          outStanceExceptions(),
        ),
      )
      .limit(1)
      .get() != null
  );
}

// Unjudged traffic per conversation (every stance): attention pass still listens to left venues.
export function unjudgedConversations(
  db: Database,
  identityId: string,
  limit = 200,
): PendingConversation[] {
  const rows = orm(db)
    .select(eventCols)
    .from(events)
    .leftJoin(conversations, convoJoin())
    .where(
      and(
        eq(events.identityId, identityId),
        inArray(events.kind, DELIVERABLE_KINDS),
        isNotNull(events.venueId),
        sql`${events}.rowid > ifnull(${conversations.judgedRowid}, 0)`,
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .limit(limit)
    .all();
  return groupByConversation(db, identityId, messagesOf(rows));
}

export function hasUnjudged(db: Database, identityId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(events)
      .leftJoin(conversations, convoJoin())
      .where(
        and(
          eq(events.identityId, identityId),
          inArray(events.kind, DELIVERABLE_KINDS),
          isNotNull(events.venueId),
          sql`${events}.rowid > ifnull(${conversations.judgedRowid}, 0)`,
        ),
      )
      .limit(1)
      .get() != null
  );
}

// Advance judged watermark (monotonic max); may trail delivered for after-the-fact bookkeeping.
export function advanceJudged(
  db: Database,
  clock: Clock,
  identityId: string,
  key: ConversationKey,
  judgedRowid: number,
): void {
  ensureConversation(db, clock, identityId, key.venueId, key.threadRootId);
  orm(db)
    .update(conversations)
    .set({ judgedRowid: sql`max(${conversations.judgedRowid}, ${judgedRowid})` })
    .where(convoEq(identityId, key.venueId, key.threadRootId))
    .run();
}

// The newest deliverable event a conversation has — the bounce card's "delivered through here".
export function maxEventRowid(
  db: Database,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): number {
  const row = orm(db)
    .select({ r: max(sql<number>`${events}.rowid`) })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, venueId),
        inArray(events.kind, DELIVERABLE_KINDS),
        threadRootId
          ? or(
              eq(events.threadRootId, threadRootId),
              sql`json_extract(${events.payload}, '$.ts') = ${threadRootId}`,
            )
          : isNull(events.threadRootId),
      ),
    )
    .get();
  return Number(row?.r ?? 0);
}
