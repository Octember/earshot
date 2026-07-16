// The Collapse (specs/2026-07-13-the-collapse-design.md): the events table IS the resident
// inbox — deduped, identity-scoped, durable. This module is just the delivery cursor over it,
// keyed by ROWID (insertion order, monotonic — timestamps tie within a busy millisecond):
// events past the cursor are undelivered; advancing the cursor after a wake makes delivery
// restart-durable (a crash re-delivers, and re-delivery is idempotent because the wake only
// SHOWS messages — ledger effects live behind their own tools).
import type { Database } from "bun:sqlite";

export interface InboxMessage {
  rowid: number;
  id: string;
  kind: "addressed_message" | "observed_message" | "external_signal";
  venueId: string | null;
  threadRootId: string | null;
  principalId: string | null;
  text: string;
  ts: string | null;
  receivedAt: string;
  // How an addressed message reached her (router.ts writes it into the payload): a direct
  // address (mention/dm) wakes the mind immediately; thread_follow is the ear's to judge.
  addressMode?: "mention" | "dm" | "thread_follow";
  files?: { name: string }[];
}

export function pendingMessages(db: Database, identityId: string, limit = 200): InboxMessage[] {
  const cursor =
    (db.query("SELECT delivered_rowid FROM resident_cursor WHERE identity_id = ?").get(identityId) as { delivered_rowid: number } | null)
      ?.delivered_rowid ?? 0;
  return messagesAfter(db, identityId, cursor, limit);
}

// The ear reads with its own watermark (attention.ts) — same rows, different cursor.
export function messagesAfter(db: Database, identityId: string, afterRowid: number, limit = 200): InboxMessage[] {
  const cursor = afterRowid;
  const rows = db
    .query(
      `SELECT rowid, id, kind, venue_id, thread_root_id, principal_id, payload, received_at FROM events
       WHERE identity_id = ? AND rowid > ? AND kind IN ('addressed_message','observed_message','external_signal')
       ORDER BY rowid LIMIT ?`,
    )
    .all(identityId, cursor, limit) as { rowid: number; id: string; kind: InboxMessage["kind"]; venue_id: string | null; thread_root_id: string | null; principal_id: string | null; payload: string; received_at: string }[];
  return rows.map((r) => {
    const p = JSON.parse(r.payload) as { text?: string; ts?: string; addressMode?: InboxMessage["addressMode"]; files?: { name: string }[] };
    return {
      rowid: r.rowid,
      id: r.id,
      kind: r.kind,
      venueId: r.venue_id,
      threadRootId: r.thread_root_id,
      principalId: r.principal_id,
      text: p.text ?? "",
      ts: p.ts ?? null,
      receivedAt: r.received_at,
      ...(p.addressMode ? { addressMode: p.addressMode } : {}),
      ...(p.files?.length ? { files: p.files } : {}),
    };
  });
}

export function advanceCursor(db: Database, identityId: string, deliveredRowid: number): void {
  db.query(
    `INSERT INTO resident_cursor (identity_id, delivered_rowid) VALUES (?, ?)
     ON CONFLICT(identity_id) DO UPDATE SET delivered_rowid = excluded.delivered_rowid
     WHERE excluded.delivered_rowid > resident_cursor.delivered_rowid`,
  ).run(identityId, deliveredRowid);
}
