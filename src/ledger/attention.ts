// The Ear (specs/2026-07-13-the-ear-design.md): attention items — what she owes — and the ear's
// judged-watermark over the events table. Items are opened by ear verdicts, optimistically closed
// by her own in-thread reply/react (the harness bookkeeping an observable fact, not judging), and
// reopened only by ear verdicts. Open items ride the wake prompt, capped; the oldest past max-age
// is flagged to the mind's own judgment rather than trusted to the ear's closure call forever.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";

export interface AttentionItem {
  id: string;
  identityId: string;
  venueId: string;
  threadRootId: string | null;
  askTs: string | null;
  what: string;
  openedAt: string;
}

export function openAttentionItem(
  db: Database,
  clock: Clock,
  item: { id: string; identityId: string; venueId: string; threadRootId: string | null; askTs: string | null; what: string },
): void {
  // One open item per ask: same thread + ask ts while open is a duplicate verdict, not a new debt.
  const dup = db
    .query("SELECT 1 FROM attention_items WHERE identity_id = ? AND venue_id = ? AND thread_root_id IS ? AND ask_ts IS ? AND closed_at IS NULL")
    .get(item.identityId, item.venueId, item.threadRootId, item.askTs);
  if (dup) return;
  db.query("INSERT INTO attention_items (id, identity_id, venue_id, thread_root_id, ask_ts, what, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    item.id,
    item.identityId,
    item.venueId,
    item.threadRootId,
    item.askTs,
    item.what,
    clock(),
  );
}

// Optimistic close: she answered in that thread. Returns how many items this settled.
export function closeAttentionItemsForThread(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null, cause: string): number {
  const result = db
    .query("UPDATE attention_items SET closed_at = ?, closed_cause = ? WHERE identity_id = ? AND venue_id = ? AND thread_root_id IS ? AND closed_at IS NULL")
    .run(clock(), cause, identityId, venueId, threadRootId);
  return result.changes;
}

export function closeAttentionItem(db: Database, clock: Clock, id: string, cause: string): boolean {
  return db.query("UPDATE attention_items SET closed_at = ?, closed_cause = ? WHERE id = ? AND closed_at IS NULL").run(clock(), cause, id).changes > 0;
}

export function reopenAttentionItem(db: Database, id: string): boolean {
  // "The ear MAY reopen one that truly was hers" (SPEC §13) covers its own closes and even a
  // step_back's — but never an operator's close: that judgment outranks the ear's.
  return db
    .query("UPDATE attention_items SET closed_at = NULL, closed_cause = NULL WHERE id = ? AND (closed_cause IS NULL OR closed_cause NOT LIKE 'operator:%')")
    .run(id).changes > 0;
}

export function openItems(db: Database, identityId: string, limit = 50): AttentionItem[] {
  const rows = db
    .query("SELECT id, identity_id, venue_id, thread_root_id, ask_ts, what, opened_at FROM attention_items WHERE identity_id = ? AND closed_at IS NULL ORDER BY opened_at LIMIT ?")
    .all(identityId, limit) as { id: string; identity_id: string; venue_id: string; thread_root_id: string | null; ask_ts: string | null; what: string; opened_at: string }[];
  return rows.map((r) => ({ id: r.id, identityId: r.identity_id, venueId: r.venue_id, threadRootId: r.thread_root_id, askTs: r.ask_ts, what: r.what, openedAt: r.opened_at }));
}

// --- the ear's own watermark (never the mind's resident_cursor) ---

export function earCursor(db: Database, identityId: string): number {
  return (db.query("SELECT judged_rowid FROM ear_cursor WHERE identity_id = ?").get(identityId) as { judged_rowid: number } | null)?.judged_rowid ?? 0;
}

export function advanceEarCursor(db: Database, identityId: string, judgedRowid: number): void {
  db.query(
    `INSERT INTO ear_cursor (identity_id, judged_rowid) VALUES (?, ?)
     ON CONFLICT(identity_id) DO UPDATE SET judged_rowid = excluded.judged_rowid
     WHERE excluded.judged_rowid > ear_cursor.judged_rowid`,
  ).run(identityId, judgedRowid);
}
