// SPEC §5 — interactive continuity. The agent runs one codex thread (rollout) PER ANCHOR so that
// successive turns in the same Slack thread/DM resume the same conversation instead of starting
// cold each time. This module is the durable anchor→codex-thread map; the service resumes the
// stored id (falling back to a fresh thread on failure) and writes back the resolved id each turn.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";

// A null thread root (DM / top-level channel message) normalizes to '' so it participates in the
// primary key — the same normalization turn-admission's AnchorKey uses.
function rootKey(threadRootId: string | null): string {
  return threadRootId ?? "";
}

export function getConversationThread(
  db: Database,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): string | null {
  const row = db
    .query("SELECT codex_thread_id FROM conversation_threads WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?")
    .get(identityId, venueId, rootKey(threadRootId)) as { codex_thread_id: string } | null;
  return row?.codex_thread_id ?? null;
}

export function setConversationThread(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
  codexThreadId: string,
): void {
  db.query(
    `INSERT INTO conversation_threads (identity_id, venue_id, thread_root_id, codex_thread_id, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (identity_id, venue_id, thread_root_id)
       DO UPDATE SET codex_thread_id = excluded.codex_thread_id, updated_at = excluded.updated_at`,
  ).run(identityId, venueId, rootKey(threadRootId), codexThreadId, clock());
}
