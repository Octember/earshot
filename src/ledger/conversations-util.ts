import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { and, eq, gt, inArray, isNotNull, isNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { Anchor } from "./tasks-types";
import { conversations, events } from "./schema";

export const DELIVERABLE_KINDS = ["addressed_message", "observed_message"] as const;

export const eventTs = sql<string | null>`json_extract(${events.payload}, '$.ts')`;

export function sameNullable(column: SQLiteColumn, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

export function conversationEventsWhere(identityId: string, key: Anchor, extra?: SQL) {
  const scope = and(
    eq(events.identityId, identityId),
    eq(events.venueId, key.venueId),
    key.threadRootId
      ? or(eq(events.threadRootId, key.threadRootId), eq(eventTs, key.threadRootId))
      : isNull(events.threadRootId),
  );
  return and(scope, extra);
}

export function convoJoin() {
  return and(
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
) {
  return gt(events.rowid, watermark);
}

export function eventAfterDeliveredRowid() {
  return afterWatermark(conversations.deliveredRowid);
}

export function eventAfterJudgedRowid() {
  return afterWatermark(conversations.judgedRowid);
}

export function deliverableForIdentity(identityId: string) {
  return and(eq(events.identityId, identityId), inArray(events.kind, DELIVERABLE_KINDS));
}

export function addressedForIdentity(identityId: string, watermark: SQL | undefined) {
  return and(eq(events.identityId, identityId), eq(events.kind, "addressed_message"), watermark);
}

export function outStanceExceptions() {
  return and(
    or(
      isNull(conversations.stance),
      ne(conversations.stance, "out"),
      isNotNull(conversations.wakeWhy),
    ),
  );
}
