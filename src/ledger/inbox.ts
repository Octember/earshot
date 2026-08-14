// The Collapse (specs/2026-07-13-the-collapse-design.md): the events table IS the resident
// inbox — deduped, identity-scoped, durable. This module is just the delivery cursor over it,
// keyed by ROWID (insertion order, monotonic — timestamps tie within a busy millisecond):
// events past the cursor are undelivered; advancing the cursor after a wake makes delivery
// restart-durable (a crash re-delivers, and re-delivery is idempotent because the wake only
// SHOWS messages — ledger effects live behind their own tools).
import type { Database } from "bun:sqlite";
import { many, one } from "./db";
import { isRecord, parseJson } from "../guard";

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
  // How an addressed message reached her (router.ts writes it into the payload): a direct
  // address (mention/dm) wakes the mind immediately; thread_follow is the ear's to judge.
  addressMode?: "mention" | "dm" | "thread_follow";
  // Attachment metadata as the router recorded it. urlPrivate is how a turn addresses the
  // original file (download_file) — older events carry name only.
  files?: { name: string; mimetype?: string; urlPrivate?: string; size?: number }[];
}

function inboxFiles(v: unknown): InboxMessage["files"] | undefined {
  if (!Array.isArray(v) || v.length === 0) return undefined;
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
  return files.length ? files : undefined;
}

export function pendingMessages(db: Database, identityId: string, limit = 200): InboxMessage[] {
  const cursor = one<{ delivered_rowid: number }>(db, "SELECT delivered_rowid FROM resident_cursor WHERE identity_id = ?", identityId)?.delivered_rowid ?? 0;
  return messagesAfter(db, identityId, cursor, limit);
}

// The ear reads with its own watermark (attention.ts) — same rows, different cursor.
export function messagesAfter(db: Database, identityId: string, afterRowid: number, limit = 200): InboxMessage[] {
  const cursor = afterRowid;
  const rows = many<{
    rowid: number;
    id: string;
    kind: InboxMessage["kind"];
    venue_id: string | null;
    thread_root_id: string | null;
    principal_id: string | null;
    payload: string;
    received_at: string;
  }>(
    db,
    `SELECT rowid, id, kind, venue_id, thread_root_id, principal_id, payload, received_at FROM events
       WHERE identity_id = ? AND rowid > ? AND kind IN ('addressed_message','observed_message','external_signal')
       ORDER BY rowid LIMIT ?`,
    identityId,
    cursor,
    limit,
  );
  return rows.map((r) => {
    const parsed = parseJson(r.payload);
    const p = isRecord(parsed) ? parsed : {};
    const files = inboxFiles(p.files);
    return {
      rowid: r.rowid,
      id: r.id,
      kind: r.kind,
      venueId: r.venue_id,
      threadRootId: r.thread_root_id,
      principalId: r.principal_id,
      text: typeof p.text === "string" ? p.text : "",
      ts: typeof p.ts === "string" ? p.ts : null,
      receivedAt: r.received_at,
      ...(typeof p.principalName === "string" ? { principalName: p.principalName } : {}),
      ...(p.addressMode === "mention" || p.addressMode === "dm" || p.addressMode === "thread_follow"
        ? { addressMode: p.addressMode }
        : {}),
      ...(files ? { files } : {}),
    };
  });
}

// The already-heard tail of a thread (rows at or before a cursor) — the ear design's "plus the
// live threads that delta touches". A mid-thread "you" is undecidable without the messages
// around it (live 2026-07-30: a one-line batch read an offer to a teammate as aimed at her).
// Root match as in threads.ts: a reply carries thread_root_id, the parent is its own ts.
export function threadTailBefore(db: Database, identityId: string, venueId: string, threadRootId: string, throughRowid: number, limit = 8): { principalId: string | null; principalName?: string; text: string }[] {
  const rows = many<{ principal_id: string | null; text: string | null; name: string | null }>(
    db,
    `SELECT principal_id, json_extract(payload, '$.text') AS text, json_extract(payload, '$.principalName') AS name FROM events
       WHERE identity_id = ? AND venue_id = ? AND rowid <= ?
         AND kind IN ('addressed_message','observed_message')
         AND (thread_root_id = ? OR json_extract(payload, '$.ts') = ?)
       ORDER BY rowid DESC LIMIT ?`,
    identityId,
    venueId,
    throughRowid,
    threadRootId,
    threadRootId,
    limit,
  );
  return rows.toReversed().map((r) => ({ principalId: r.principal_id, ...(r.name ? { principalName: r.name } : {}), text: r.text ?? "" }));
}

export function advanceCursor(db: Database, identityId: string, deliveredRowid: number): void {
  db.query(
    `INSERT INTO resident_cursor (identity_id, delivered_rowid) VALUES (?, ?)
     ON CONFLICT(identity_id) DO UPDATE SET delivered_rowid = excluded.delivered_rowid
     WHERE excluded.delivered_rowid > resident_cursor.delivered_rowid`,
  ).run(identityId, deliveredRowid);
}
