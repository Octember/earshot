import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { and, eq, isNull, or, type SQL } from "drizzle-orm";
import type { Anchor } from "./tasks-types";
import { events } from "./schema";

export function sameNullable(column: SQLiteColumn, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

export function conversationEventsWhere(identityId: string, key: Anchor, extra?: SQL) {
  const scope = and(
    eq(events.identityId, identityId),
    eq(events.venueId, key.venueId),
    key.threadRootId
      ? or(eq(events.threadRootId, key.threadRootId), eq(events.ts, key.threadRootId))
      : isNull(events.threadRootId),
  );
  return and(scope, extra);
}
