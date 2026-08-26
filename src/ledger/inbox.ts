// The events table IS the inbox — deduped, identity-scoped, durable. Delivery itself is
// per-conversation (ledger/conversations.ts owns the watermarks); this module keeps the row
// shape and the raw after-rowid read that §5.5's moved-check uses.
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
  // The principal's human name as the adapter resolved it at ingestion (absent on events from
  // before names existed, or when the roster missed). Rendering only; principalId stays the key.
  principalName?: string;
  text: string;
  ts: string | null;
  receivedAt: string;
  // How an addressed message reached this identity: direct address wakes immediately;
  // thread_follow is for the attention pass to judge.
  addressMode?: "mention" | "dm" | "thread_follow";
  // Attachment metadata as the router recorded it. urlPrivate is how a turn addresses the
  // original file (download_file) — older events carry name only.
  files?: { name: string; mimetype?: string; urlPrivate?: string; size?: number }[];
}

function asInboxKind(v: string): InboxMessage["kind"] {
  return v === "addressed_message" || v === "external_signal" ? v : "observed_message";
}

function asAddressMode(v: unknown): InboxMessage["addressMode"] | undefined {
  return v === "mention" || v === "dm" || v === "thread_follow" ? v : undefined;
}

function parseFiles(v: unknown): InboxMessage["files"] {
  if (!Array.isArray(v)) return undefined;
  const files: NonNullable<InboxMessage["files"]> = [];
  for (const item of v) {
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

export function messagesAfter(db: Database, identityId: string, afterRowid: number, limit = 200): InboxMessage[] {
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
  return rows.map((r) => {
    const p = isRecord(r.payload) ? r.payload : {};
    const addressMode = asAddressMode(p.addressMode);
    const files = parseFiles(p.files);
    const msg: InboxMessage = {
      rowid: r.rowid,
      id: r.id,
      kind: asInboxKind(r.kind),
      venueId: r.venueId,
      threadRootId: r.threadRootId,
      principalId: r.principalId,
      text: asString(p.text),
      ts: typeof p.ts === "string" ? p.ts : null,
      receivedAt: r.receivedAt,
    };
    if (typeof p.principalName === "string") msg.principalName = p.principalName;
    if (addressMode) msg.addressMode = addressMode;
    if (files && files.length > 0) msg.files = files;
    return msg;
  });
}

