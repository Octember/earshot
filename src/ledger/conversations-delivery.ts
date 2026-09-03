import type { Database } from "bun:sqlite";
import { and, asc, eq, getTableColumns, ne, type SQL } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { conversations, events } from "./schema";
import type { Event } from "./schema";
import type { Anchor } from "./tasks-types";
import {
  convoEq,
  convoKey,
  ensureConversation,
  stanceOf,
  type PendingConversation,
} from "./conversations-stance";
import {
  addressedForIdentity,
  convoJoin,
  deliverableForIdentity,
  eventAfterDeliveredRowid,
  eventAfterJudgedRowid,
  isDirectAddressRow,
  mergeEventRows,
  outStanceExceptions,
} from "./conversations-util";

function groupByConversation(
  db: Database,
  identityId: string,
  messages: Event[],
): PendingConversation[] {
  const grouped = new Map<string, PendingConversation>();
  for (const message of messages) {
    const key = convoKey(message.venueId, message.threadRootId);
    let group = grouped.get(key);
    if (!group) {
      group = {
        venueId: message.venueId,
        threadRootId: message.threadRootId,
        stance: stanceOf(db, identityId, message.venueId, message.threadRootId),
        messages: [],
      };
      grouped.set(key, group);
    }
    group.messages.push(message);
  }
  return [...grouped.values()];
}

function selectJoinedEvents(db: Database, where: SQL | undefined, limit?: number): Event[] {
  const base = orm(db)
    .select(getTableColumns(events))
    .from(events)
    .leftJoin(conversations, convoJoin())
    .where(where)
    .orderBy(asc(events.rowid));
  if (limit !== undefined) return base.limit(limit).all();
  return base.all();
}

function batch(
  db: Database,
  identityId: string,
  limit: number,
  watermark: SQL | undefined,
): Event[] {
  const rows = selectJoinedEvents(
    db,
    and(deliverableForIdentity(identityId), watermark, outStanceExceptions()),
    limit,
  );
  const direct = selectJoinedEvents(db, addressedForIdentity(identityId, watermark)).filter((row) =>
    isDirectAddressRow(row),
  );
  return mergeEventRows(rows, direct);
}

function hasPending(db: Database, identityId: string, watermark: SQL | undefined): boolean {
  const scoped = orm(db)
    .select({ id: events.id })
    .from(events)
    .leftJoin(conversations, convoJoin())
    .where(and(deliverableForIdentity(identityId), watermark, outStanceExceptions()))
    .limit(1)
    .get();
  return (
    scoped != null ||
    selectJoinedEvents(db, addressedForIdentity(identityId, watermark)).some((row) =>
      isDirectAddressRow(row),
    )
  );
}

export function pendingConversations(
  db: Database,
  identityId: string,
  limit = 200,
): PendingConversation[] {
  return groupByConversation(
    db,
    identityId,
    batch(db, identityId, limit, eventAfterDeliveredRowid()),
  );
}

export function hasUndelivered(db: Database, identityId: string): boolean {
  return hasPending(db, identityId, eventAfterDeliveredRowid());
}

export function unjudgedConversations(
  db: Database,
  identityId: string,
  limit = 200,
): PendingConversation[] {
  return groupByConversation(db, identityId, batch(db, identityId, limit, eventAfterJudgedRowid()));
}

export function hasUnjudged(db: Database, identityId: string): boolean {
  return hasPending(db, identityId, eventAfterJudgedRowid());
}

export function drainOutStanceJudgments(db: Database, clock: Clock, identityId: string): number {
  const scoped = and(
    deliverableForIdentity(identityId),
    eventAfterJudgedRowid(),
    eq(conversations.stance, "out"),
    ne(events.kind, "external_signal"),
  );
  const rows = selectJoinedEvents(db, scoped).filter((row) => !isDirectAddressRow(row));
  const convos = groupByConversation(db, identityId, rows);
  for (const convo of convos) {
    advanceJudgedSkipped(db, clock, identityId, convo, convo.messages.at(-1)!.rowid);
  }
  return convos.length;
}

function advanceJudgedSkipped(
  db: Database,
  clock: Clock,
  identityId: string,
  key: Anchor,
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
      wakeWhy: null,
    })
    .where(convoEq(identityId, key.venueId, key.threadRootId))
    .run();
}

export function advanceJudged(
  db: Database,
  clock: Clock,
  identityId: string,
  key: Anchor,
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
