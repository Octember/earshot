import type { Database } from "bun:sqlite";
import { asc, type SQL } from "drizzle-orm";
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
  addressedForIdentity,
  convoJoin,
  deliverableForIdentity,
  directAddressRows,
  eventAfterDeliveredRowid,
  eventAfterJudgedRowid,
  eventCols,
  eventRowid,
  hasMatchingEvent,
  isDirectAddressRow,
  mergeEventRows,
  messagesOf,
  outStanceExceptions,
  outStanceSkippedScope,
  scopeAnd,
  type EventRow,
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

function selectJoinedEvents(db: Database, where: SQL, limit?: number): EventRow[] {
  const base = orm(db)
    .select(eventCols)
    .from(events)
    .leftJoin(conversations, convoJoin())
    .where(where)
    .orderBy(asc(eventRowid));
  if (limit !== undefined) return base.limit(limit).all();
  return base.all();
}

function pendingBatch(db: Database, identityId: string, limit: number): EventRow[] {
  const scoped = scopeAnd(
    deliverableForIdentity(identityId),
    eventAfterDeliveredRowid(),
    outStanceExceptions(),
  );
  const rows = selectJoinedEvents(db, scoped, limit);
  const direct = directAddressRows(
    selectJoinedEvents(db, addressedForIdentity(identityId, eventAfterDeliveredRowid())),
  );
  return mergeEventRows(rows, direct);
}

function unjudgedBatch(db: Database, identityId: string, limit: number): EventRow[] {
  const scoped = scopeAnd(
    deliverableForIdentity(identityId),
    eventAfterJudgedRowid(),
    outStanceExceptions(),
  );
  const rows = selectJoinedEvents(db, scoped, limit);
  const direct = directAddressRows(
    selectJoinedEvents(db, addressedForIdentity(identityId, eventAfterJudgedRowid())),
  );
  return mergeEventRows(rows, direct);
}

function hasDirectAddress(db: Database, identityId: string, afterWatermark: SQL): boolean {
  return (
    directAddressRows(selectJoinedEvents(db, addressedForIdentity(identityId, afterWatermark)))
      .length > 0
  );
}

export function pendingConversations(
  db: Database,
  identityId: string,
  limit = 200,
): PendingConversation[] {
  return groupByConversation(db, identityId, messagesOf(pendingBatch(db, identityId, limit)));
}

export function hasUndelivered(db: Database, identityId: string): boolean {
  const scoped = scopeAnd(
    deliverableForIdentity(identityId),
    eventAfterDeliveredRowid(),
    outStanceExceptions(),
  );
  return (
    hasMatchingEvent(db, scoped) || hasDirectAddress(db, identityId, eventAfterDeliveredRowid())
  );
}

// Unjudged traffic the ear should judge — mirrors pendingConversations' out-stance filter.
export function unjudgedConversations(
  db: Database,
  identityId: string,
  limit = 200,
): PendingConversation[] {
  return groupByConversation(db, identityId, messagesOf(unjudgedBatch(db, identityId, limit)));
}

export function hasUnjudged(db: Database, identityId: string): boolean {
  const scoped = scopeAnd(
    deliverableForIdentity(identityId),
    eventAfterJudgedRowid(),
    outStanceExceptions(),
  );
  return hasMatchingEvent(db, scoped) || hasDirectAddress(db, identityId, eventAfterJudgedRowid());
}

// Step-back venues: observed chatter never reaches the ear — drain judged cursor + holds.
export function drainOutStanceJudgments(db: Database, clock: Clock, identityId: string): number {
  const scoped = scopeAnd(
    deliverableForIdentity(identityId),
    eventAfterJudgedRowid(),
    outStanceSkippedScope(),
  );
  const rows = selectJoinedEvents(db, scoped).filter((row) => !isDirectAddressRow(row));
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
  const current =
    orm(db)
      .select({ judgedRowid: conversations.judgedRowid })
      .from(conversations)
      .where(convoEq(identityId, key.venueId, key.threadRootId))
      .get()?.judgedRowid ?? 0;
  orm(db)
    .update(conversations)
    .set({
      judgedRowid: Math.max(current, judgedRowid),
      holds: 0,
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
  const current =
    orm(db)
      .select({ judgedRowid: conversations.judgedRowid })
      .from(conversations)
      .where(convoEq(identityId, key.venueId, key.threadRootId))
      .get()?.judgedRowid ?? 0;
  orm(db)
    .update(conversations)
    .set({ judgedRowid: Math.max(current, judgedRowid) })
    .where(convoEq(identityId, key.venueId, key.threadRootId))
    .run();
}
