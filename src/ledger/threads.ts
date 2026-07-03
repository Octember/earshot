// SPEC §5.1 — "a thread where the agent has previously posted or been mentioned." Both halves
// (a member's addressed message, or the agent's own outbound post) call recordThreadParticipation;
// the router's addressing classification then only needs this one table, not two different checks.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";

export function recordThreadParticipation(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string): void {
  db.query(
    "INSERT OR IGNORE INTO thread_participation (venue_id, thread_root_id, identity_id, first_at) VALUES (?, ?, ?, ?)",
  ).run(venueId, threadRootId, identityId, clock());
}

export function isThreadParticipant(db: Database, venueId: string, threadRootId: string): boolean {
  const row = db.query("SELECT 1 FROM thread_participation WHERE venue_id = ? AND thread_root_id = ?").get(venueId, threadRootId);
  return row !== null;
}
