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

export interface ConversationThread {
  codexThreadId: string;
  // Turns run against this codex thread. The rotation input: a thread past its context window
  // compacts away its oldest history first (AGENTS.md, the soul), so callers rotate before then.
  turnCount: number;
}

export function getConversationThread(
  db: Database,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): ConversationThread | null {
  const row = db
    .query("SELECT codex_thread_id, turn_count FROM conversation_threads WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?")
    .get(identityId, venueId, rootKey(threadRootId)) as { codex_thread_id: string; turn_count: number } | null;
  return row ? { codexThreadId: row.codex_thread_id, turnCount: row.turn_count } : null;
}

export interface RecentConversation {
  venueId: string;
  threadRootId: string | null;
  lastAt: string;
  snippet: string; // latest addressed message text, truncated — a pointer, not a transcript
}

// The identity's recent conversations across ALL threads — the digest injected into a fresh
// interactive turn so a new thread doesn't start amnesiac about the others (SPEC §5/§8 "smart
// across threads"). One row per (venue, thread), newest first, excluding the current thread.
export function recentConversations(
  db: Database,
  identityId: string,
  opts: { exclude?: { venueId: string; threadRootId: string | null }; limit?: number } = {},
): RecentConversation[] {
  const rows = db
    .query(
      `SELECT venue_id, ifnull(thread_root_id, '') AS root, MAX(received_at) AS last_at,
              (SELECT payload FROM events e2
                WHERE e2.identity_id = e.identity_id AND e2.venue_id = e.venue_id
                  AND ifnull(e2.thread_root_id, '') = ifnull(e.thread_root_id, '')
                  AND e2.kind = 'addressed_message'
                ORDER BY e2.received_at DESC LIMIT 1) AS payload
         FROM events e
        WHERE identity_id = ? AND kind = 'addressed_message'
        GROUP BY venue_id, ifnull(thread_root_id, '')
        ORDER BY last_at DESC LIMIT ?`,
    )
    .all(identityId, opts.limit ?? 8) as { venue_id: string; root: string; last_at: string; payload: string }[];
  return rows
    .filter((r) => !(opts.exclude && r.venue_id === opts.exclude.venueId && r.root === rootKey(opts.exclude.threadRootId)))
    .map((r) => ({
      venueId: r.venue_id,
      threadRootId: r.root || null,
      lastAt: r.last_at,
      snippet: ((JSON.parse(r.payload) as { text?: string }).text ?? "").slice(0, 90),
    }));
}

// Called once per turn (after resume/start): the same codex thread accrues turn_count, a new one
// (first turn or rotation) resets it to 1.
export function setConversationThread(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
  codexThreadId: string,
): void {
  db.query(
    `INSERT INTO conversation_threads (identity_id, venue_id, thread_root_id, codex_thread_id, turn_count, updated_at)
       VALUES (?, ?, ?, ?, 1, ?)
       ON CONFLICT (identity_id, venue_id, thread_root_id)
       DO UPDATE SET turn_count = CASE WHEN conversation_threads.codex_thread_id = excluded.codex_thread_id
                                       THEN conversation_threads.turn_count + 1 ELSE 1 END,
                     codex_thread_id = excluded.codex_thread_id,
                     updated_at = excluded.updated_at`,
  ).run(identityId, venueId, rootKey(threadRootId), codexThreadId, clock());
}

// Drops an anchor's mapping outright — for a codex thread the runtime can no longer load (its
// history outgrew the gateway's payload limit or the model's context window): every future resume
// would fail identically, so the next turn must cold-start instead of wedging the anchor forever.
export function clearConversationThread(db: Database, identityId: string, venueId: string, threadRootId: string | null): void {
  db.query("DELETE FROM conversation_threads WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?").run(identityId, venueId, rootKey(threadRootId));
}
