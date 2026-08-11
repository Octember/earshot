// The events table IS the inbox — deduped, identity-scoped, durable. Delivery itself is
// per-conversation (ledger/conversations.ts owns the watermarks); this module keeps the row
// shape and the raw after-rowid read that §5.5's moved-check uses.
import type { Database } from "bun:sqlite";

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
    const p = JSON.parse(r.payload) as { text?: string; ts?: string; principalName?: string; addressMode?: InboxMessage["addressMode"]; files?: InboxMessage["files"] };
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
      ...(p.principalName ? { principalName: p.principalName } : {}),
      ...(p.addressMode ? { addressMode: p.addressMode } : {}),
      ...(p.files?.length ? { files: p.files } : {}),
    };
  });
}

