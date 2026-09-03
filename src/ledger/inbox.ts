// Events as inbox rows; delivery watermarks live in conversations.ts.
import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { parseEventPayload, type EventPayload } from "../schemas/event-payload";
import { orm } from "./db";
import { events } from "./schema";

export type InboxMessage = {
  rowid: number;
  id: string;
  kind: "addressed_message" | "observed_message" | "external_signal";
  venueId: string | null;
  threadRootId: string | null;
  principalId: string | null;
  receivedAt: string;
} & EventPayload;

// A line spoken to her (mention or DM), as opposed to thread-follow or observed chatter.
export function isDirectAddress(message: Pick<InboxMessage, "addressMode">): boolean {
  return message.addressMode === "mention" || message.addressMode === "dm";
}

export function asInboxKind(value: string): InboxMessage["kind"] {
  return value === "addressed_message" || value === "external_signal" ? value : "observed_message";
}

export function messagesAfter(
  db: Database,
  identityId: string,
  afterRowid: number,
  limit = 200,
): InboxMessage[] {
  const rows = orm(db)
    .select({
      rowid: sql<number>`${events}.rowid`,
      id: events.id,
      kind: events.kind,
      venueId: events.venueId,
      threadRootId: events.threadRootId,
      principalId: events.principalId,
      payload: events.payload,
      receivedAt: events.receivedAt,
    })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        gt(sql`${events}.rowid`, afterRowid),
        inArray(events.kind, ["addressed_message", "observed_message", "external_signal"]),
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .limit(limit)
    .all();
  return rows.map((row) =>
    Object.assign(parseEventPayload(row.payload), {
      rowid: row.rowid,
      id: row.id,
      kind: asInboxKind(row.kind),
      venueId: row.venueId,
      threadRootId: row.threadRootId,
      principalId: row.principalId,
      receivedAt: row.receivedAt,
    }),
  );
}
