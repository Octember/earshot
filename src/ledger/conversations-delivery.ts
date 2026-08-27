import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";
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

// Out-stance observed traffic skips the ear; advance judged and clear stale holds.
const outStanceSkipped = sql`(
  ifnull(${conversations.stance}, 'none') = 'out'
  AND ${events.kind} != 'external_signal'
  AND NOT (
    ${events.kind} = 'addressed_message'
    AND json_extract(${events.payload}, '$.addressMode') IN ('mention', 'dm')
  )
)`;

function mergeUnjudgedRows(
  db: Database,
  identityId: string,
  rows: Parameters<typeof messagesOf>[0],
  direct: Parameters<typeof messagesOf>[0],
): PendingConversation[] {
  const seen = new Set(rows.map((row) => row.rowid));
  const merged = [...rows, ...direct.filter((row) => !seen.has(row.rowid))].toSorted(
    (a, b) => a.rowid - b.rowid,
  );
  return groupByConversation(db, identityId, messagesOf(merged));
}

// Unjudged traffic the ear should judge — mirrors pendingConversations' out-stance filter.
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
        sql`${events}.rowid > ifnull(${conversations.judgedRowid}, 0)`,
        sql`json_extract(${events.payload}, '$.addressMode') IN ('mention', 'dm')`,
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .all();
  return mergeUnjudgedRows(db, identityId, rows, direct);
}

export function hasUnjudged(db: Database, identityId: string): boolean {
  const scoped = and(
    eq(events.identityId, identityId),
    inArray(events.kind, DELIVERABLE_KINDS),
    isNotNull(events.venueId),
    sql`${events}.rowid > ifnull(${conversations.judgedRowid}, 0)`,
    outStanceExceptions(),
  );
  if (
    orm(db)
      .select({ one: sql`1` })
      .from(events)
      .leftJoin(conversations, convoJoin())
      .where(scoped)
      .limit(1)
      .get() != null
  ) {
    return true;
  }
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(events)
      .leftJoin(conversations, convoJoin())
      .where(
        and(
          eq(events.identityId, identityId),
          eq(events.kind, "addressed_message"),
          isNotNull(events.venueId),
          sql`${events}.rowid > ifnull(${conversations.judgedRowid}, 0)`,
          sql`json_extract(${events.payload}, '$.addressMode') IN ('mention', 'dm')`,
        ),
      )
      .limit(1)
      .get() != null
  );
}

// Step-back venues: observed chatter never reaches the ear — drain judged cursor + holds.
export function drainOutStanceJudgments(db: Database, clock: Clock, identityId: string): number {
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
        outStanceSkipped,
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .all();
  const convos = groupByConversation(db, identityId, messagesOf(rows));
  for (const convo of convos) {
    advanceJudgedSkipped(db, clock, identityId, convo, convo.messages.at(-1)!.rowid);
  }
  return convos.length;
}

function advanceJudgedSkipped(
  db: Database,
  clock: Clock,
  identityId: string,
  key: ConversationKey,
  judgedRowid: number,
): void {
  ensureConversation(db, clock, identityId, key.venueId, key.threadRootId);
  orm(db)
    .update(conversations)
    .set({
      judgedRowid: sql`max(${conversations.judgedRowid}, ${judgedRowid})`,
      holds: 0,
      holdWhys: [],
      wakeWhy: null,
    })
    .where(convoEq(identityId, key.venueId, key.threadRootId))
    .run();
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
