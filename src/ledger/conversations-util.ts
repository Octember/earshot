import type { Database } from "bun:sqlite";
import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { ConversationKey } from "./conversations-stance";
import { parseEventPayload } from "../schemas/event-payload";
import { orm } from "./db";
import { acts, conversations, events } from "./schema";
import type { InboxMessage } from "./inbox";

export const DELIVERABLE_KINDS = [
  "addressed_message",
  "observed_message",
  "external_signal",
] as const;

export function scopeAnd(...conditions: (SQL | undefined)[]): SQL {
  const merged = and(
    ...conditions.filter((condition): condition is SQL => condition !== undefined),
  );
  if (!merged) throw new Error("scopeAnd: empty filter");
  return merged;
}

export const eventRowid = sql<number>`${events}.rowid`;

export const eventCols = {
  rowid: eventRowid.as("rowid"),
  id: events.id,
  kind: events.kind,
  venueId: events.venueId,
  threadRootId: events.threadRootId,
  principalId: events.principalId,
  payload: events.payload,
  receivedAt: events.receivedAt,
};

export type EventRow = { rowid: number } & Pick<
  typeof events.$inferSelect,
  "id" | "kind" | "venueId" | "threadRootId" | "principalId" | "payload" | "receivedAt"
>;

export function sameNullable(
  column: typeof events.threadRootId | typeof acts.threadRootId,
  value: string | null,
) {
  return value === null ? isNull(column) : eq(column, value);
}

// Thread replies + root message ts, or top-level channel lines when threadRootId is null.
export function threadScopeFilter(threadRootId: string | null) {
  return threadRootId
    ? or(
        eq(events.threadRootId, threadRootId),
        sql`json_extract(${events.payload}, '$.ts') = ${threadRootId}`,
      )
    : isNull(events.threadRootId);
}

export function conversationEventsWhere(identityId: string, key: ConversationKey, extra?: SQL) {
  const scope = and(
    eq(events.identityId, identityId),
    eq(events.venueId, key.venueId),
    threadScopeFilter(key.threadRootId),
  );
  return extra ? and(scope, extra) : scope;
}

function asInboxKind(value: string): InboxMessage["kind"] {
  return value === "addressed_message" || value === "external_signal" ? value : "observed_message";
}

export function convoJoin() {
  return scopeAnd(
    eq(conversations.identityId, events.identityId),
    eq(conversations.venueId, events.venueId),
    or(
      and(isNull(events.threadRootId), eq(conversations.threadRootId, "")),
      eq(conversations.threadRootId, events.threadRootId),
    ),
  );
}

function afterWatermark(
  watermark: typeof conversations.deliveredRowid | typeof conversations.judgedRowid,
): SQL {
  return scopeAnd(or(and(isNull(watermark), gt(eventRowid, 0)), gt(eventRowid, watermark)));
}

export function eventAfterDeliveredRowid() {
  return afterWatermark(conversations.deliveredRowid);
}

export function eventAfterJudgedRowid() {
  return afterWatermark(conversations.judgedRowid);
}

export function deliverableForIdentity(identityId: string) {
  return scopeAnd(
    eq(events.identityId, identityId),
    inArray(events.kind, DELIVERABLE_KINDS),
    isNotNull(events.venueId),
  );
}

export function addressedForIdentity(identityId: string, watermark: SQL) {
  return scopeAnd(
    eq(events.identityId, identityId),
    eq(events.kind, "addressed_message"),
    isNotNull(events.venueId),
    watermark,
  );
}

// Left join may lack a conversation row — treat missing stance as "none" (not stepped out).
export function outStanceExceptions() {
  return scopeAnd(
    or(
      isNull(conversations.stance),
      ne(conversations.stance, "out"),
      eq(events.kind, "external_signal"),
      isNotNull(conversations.wakeWhy),
    ),
  );
}

// Observed traffic in a stepped-out conversation — ear skips, drain advances judged.
export function outStanceSkippedScope() {
  return scopeAnd(eq(conversations.stance, "out"), ne(events.kind, "external_signal"));
}

export function isDirectAddressRow(row: Pick<EventRow, "kind" | "payload">): boolean {
  if (row.kind !== "addressed_message") return false;
  const mode = parseEventPayload(row.payload).addressMode;
  return mode === "mention" || mode === "dm";
}

export function directAddressRows(rows: EventRow[]): EventRow[] {
  return rows.filter((row) => isDirectAddressRow(row));
}

export function mergeEventRows(rows: EventRow[], direct: EventRow[]): EventRow[] {
  const seen = new Set(rows.map((row) => row.rowid));
  return [...rows, ...direct.filter((row) => !seen.has(row.rowid))].toSorted(
    (a, b) => a.rowid - b.rowid,
  );
}

export function hasMatchingEvent(db: Database, where: SQL): boolean {
  return (
    orm(db)
      .select({ id: events.id })
      .from(events)
      .leftJoin(conversations, convoJoin())
      .where(where)
      .limit(1)
      .get() != null
  );
}

export function messagesOf(rows: EventRow[]): InboxMessage[] {
  return rows.map((row) => {
    const payload = parseEventPayload(row.payload);
    return {
      rowid: row.rowid,
      id: row.id,
      kind: asInboxKind(row.kind),
      venueId: row.venueId,
      threadRootId: row.threadRootId,
      principalId: row.principalId,
      text: payload.text,
      ts: payload.ts,
      receivedAt: row.receivedAt,
      ...(payload.principalName ? { principalName: payload.principalName } : {}),
      ...(payload.addressMode ? { addressMode: payload.addressMode } : {}),
      ...(payload.files?.length ? { files: payload.files } : {}),
    };
  });
}
