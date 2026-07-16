// SPEC §5.1 — "a thread where the agent has previously posted or been mentioned." Both halves
// (a member's addressed message, or the agent's own outbound post) call recordThreadParticipation;
// the router's addressing classification then only needs this one table, not two different checks.
//
// The Ear (specs/2026-07-13-the-ear-design.md): participation carries a step-back bit — her own
// judgment to leave a conversation. A stepped-back thread stops classifying as thread_follow and
// routes to the ear like any chatter. Re-engagement is structural: recordThreadParticipation runs
// on a mention or on her own post, and clears the bit — so a mention always wins, and a mere
// reply in a stepped-back thread (classified observed) never re-engages by itself.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";

export function recordThreadParticipation(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string): void {
  db.query(
    `INSERT INTO thread_participation (venue_id, thread_root_id, identity_id, first_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(venue_id, thread_root_id) DO UPDATE SET stepped_back_at = NULL, stepped_back_why = NULL`,
  ).run(venueId, threadRootId, identityId, clock());
}

// Every venue the ledger knows a thread root by: venues where its messages were heard (a thread
// root is either a reply's thread_root_id or a top-level message's own ts) plus venues where the
// agent itself established participation. A thread root ts is only meaningful within its venue —
// callers use this to catch a threadRootId paired with the wrong venue before posting.
export function venuesForThread(db: Database, threadRootId: string): string[] {
  const rows = db
    .query(
      `SELECT venue_id FROM events
        WHERE venue_id IS NOT NULL AND (thread_root_id = ? OR json_extract(payload, '$.ts') = ?)
       UNION
       SELECT venue_id FROM thread_participation WHERE thread_root_id = ?`,
    )
    .all(threadRootId, threadRootId, threadRootId) as { venue_id: string }[];
  return rows.map((r) => r.venue_id);
}

export function isThreadParticipant(db: Database, venueId: string, threadRootId: string): boolean {
  const row = db.query("SELECT 1 FROM thread_participation WHERE venue_id = ? AND thread_root_id = ?").get(venueId, threadRootId);
  return row !== null;
}

// Participant AND not stepped back — what thread_follow addressing actually requires.
export function isEngagedThread(db: Database, venueId: string, threadRootId: string): boolean {
  const row = db.query("SELECT stepped_back_at FROM thread_participation WHERE venue_id = ? AND thread_root_id = ?").get(venueId, threadRootId) as {
    stepped_back_at: string | null;
  } | null;
  return row !== null && row.stepped_back_at === null;
}

export function stepBackFromThread(db: Database, clock: Clock, venueId: string, threadRootId: string, why: string): boolean {
  const result = db
    .query("UPDATE thread_participation SET stepped_back_at = ?, stepped_back_why = ? WHERE venue_id = ? AND thread_root_id = ?")
    .run(clock(), why, venueId, threadRootId);
  return result.changes > 0;
}
