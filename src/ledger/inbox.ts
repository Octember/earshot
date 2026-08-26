// Events as inbox rows; delivery watermarks live in conversations.ts.
import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { asString, isRecord } from "../guard";
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
  files?: { name: string; mimetype?: string; urlPrivate?: string; size?: number }[];
}

function asInboxKind(value: string): InboxMessage["kind"] {
  return value === "addressed_message" || value === "external_signal" ? value : "observed_message";
}

function asAddressMode(value: unknown): InboxMessage["addressMode"] | undefined {
  return value === "mention" || value === "dm" || value === "thread_follow" ? value : undefined;
}

function parseFiles(value: unknown): InboxMessage["files"] {
  if (!Array.isArray(value)) return undefined;
  const files: NonNullable<InboxMessage["files"]> = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.name !== "string") continue;
    files.push({
      name: item.name,
      ...(typeof item.mimetype === "string" ? { mimetype: item.mimetype } : {}),
      ...(typeof item.urlPrivate === "string" ? { urlPrivate: item.urlPrivate } : {}),
      ...(typeof item.size === "number" ? { size: item.size } : {}),
    });
  }
  return files.length > 0 ? files : undefined;
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
    const payload = isRecord(row.payload) ? row.payload : {};
    const addressMode = asAddressMode(payload.addressMode);
    const files = parseFiles(payload.files);
    const msg: InboxMessage = {
      rowid: row.rowid,
      id: row.id,
      kind: asInboxKind(row.kind),
      venueId: row.venueId,
      threadRootId: row.threadRootId,
      principalId: row.principalId,
      text: asString(payload.text),
      ts: typeof payload.ts === "string" ? payload.ts : null,
      receivedAt: row.receivedAt,
    };
    if (typeof payload.principalName === "string") msg.principalName = payload.principalName;
    if (addressMode) msg.addressMode = addressMode;
    if (files && files.length > 0) msg.files = files;
    return msg;
  });
}
