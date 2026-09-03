import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { and, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import type { Anchor } from "./tasks-types";
import { events } from "./schema";

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
