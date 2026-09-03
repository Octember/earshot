import type { Database } from "bun:sqlite";
import { and, asc, eq, getTableColumns, ne, sql, type SQL } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { conversations, events } from "./schema";
import type { Event } from "./schema";
import type { Anchor } from "./tasks-types";
import { isDirectAddress } from "./inbox";
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

function batch(db: Database, identityId: string, watermark: SQL | undefined): Event[] {
  const rows = selectJoinedEvents(
    db,
    and(deliverableForIdentity(identityId), watermark, outStanceExceptions()),
    200,
  );
  const direct = selectJoinedEvents(db, addressedForIdentity(identityId, watermark)).filter((row) =>
    isDirectAddress(row),
  );
  const seen = new Set(rows.map((row) => row.rowid));
  return [...rows, ...direct.filter((row) => !seen.has(row.rowid))].toSorted(
    (a, b) => a.rowid - b.rowid,
  );
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
      isDirectAddress(row),
    )
  );
}

export function pendingConversations(db: Database, identityId: string): PendingConversation[] {
  return groupByConversation(db, identityId, batch(db, identityId, eventAfterDeliveredRowid()));
}

export function hasUndelivered(db: Database, identityId: string): boolean {
  return hasPending(db, identityId, eventAfterDeliveredRowid());
}

export function unjudgedConversations(db: Database, identityId: string): PendingConversation[] {
  return groupByConversation(db, identityId, batch(db, identityId, eventAfterJudgedRowid()));
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
  const rows = selectJoinedEvents(db, scoped).filter((row) => !isDirectAddress(row));
  const convos = groupByConversation(db, identityId, rows);
  for (const convo of convos) {
    advanceJudged(db, clock, identityId, convo, convo.messages.at(-1)!.rowid, {
      clearWakeWhy: true,
    });
  }
  return convos.length;
}

export function advanceJudged(
  db: Database,
  clock: Clock,
  identityId: string,
  key: Anchor,
  judgedRowid: number,
  opts: { clearWakeWhy?: boolean } = {},
): void {
  ensureConversation(db, clock, identityId, key.venueId, key.threadRootId);
  orm(db)
    .update(conversations)
    .set({
      judgedRowid: sql`max(${conversations.judgedRowid}, ${judgedRowid})`,
      ...(opts.clearWakeWhy ? { wakeWhy: null } : {}),
    })
    .where(convoEq(identityId, key.venueId, key.threadRootId))
    .run();
}
