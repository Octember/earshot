// Events as inbox rows; delivery watermarks live in conversations.ts.
import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import type { InboxMessageFile } from "../schemas/event-payload";
import { parseEventPayload } from "../schemas/event-payload";
import { orm } from "./db";
import { events } from "./schema";

export interface InboxMessage {
  rowid: number;
  id: string;
  kind: "addressed_message" | "observed_message" | "external_signal";
  venueId: string | null;
  threadRootId: string | null;
  principalId: string | null;
  principalName?: string; // display only; principalId is the key
  text: string;
  ts: string | null;
  receivedAt: string;
  addressMode?: "mention" | "dm" | "thread_follow";
  isBot?: boolean;
  files?: InboxMessageFile[];
}

function asInboxKind(value: string): InboxMessage["kind"] {
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
  return rows.map((row) => {
    const payload = parseEventPayload(row.payload);
    const msg: InboxMessage = {
      rowid: row.rowid,
      id: row.id,
      kind: asInboxKind(row.kind),
      venueId: row.venueId,
      threadRootId: row.threadRootId,
      principalId: row.principalId,
      text: payload.text,
      ts: payload.ts,
      receivedAt: row.receivedAt,
    };
    if (payload.principalName) msg.principalName = payload.principalName;
    if (payload.addressMode) msg.addressMode = payload.addressMode;
    if (payload.files?.length) msg.files = payload.files;
    return msg;
  });
}
