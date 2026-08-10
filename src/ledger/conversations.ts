// One room, one row (specs/2026-08-10-one-room-redesign.md, P1): the conversation as the ledger
// unit. Each (identity, venue, thread root) owns its watermarks and — the load-bearing part —
// its JUDGMENT: the ear's holds stop being discarded verdicts and become rows that delivery
// cannot arrive without (live 2026-08-10: four "this is settled" holds evaporated, and an
// unrelated wake received the held messages as bare lines and posted stale into the thread).
// A null thread root (top-level channel surface) normalizes to '' for the primary key, the same
// normalization the router and continuity use.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";

const HOLD_WHY_KEEP = 4; // bounded history — never a single latest-wins why (a stale one would render as live fact)

export interface ConversationJudgment {
  venueId: string;
  threadRootId: string | null;
  holds: number;
  holdWhys: string[];
  wakeWhy: string | null;
}

function rootKey(threadRootId: string | null): string {
  return threadRootId ?? "";
}

export function ensureConversation(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null): void {
  db.query(
    "INSERT INTO conversations (identity_id, venue_id, thread_root_id, first_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(identityId, venueId, rootKey(threadRootId), clock());
}

// An ear hold: judged "nothing needed from her", durably. The why joins a bounded history so a
// conversation held four times renders four reads, not one stale latest.
export function recordHold(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null, why: string): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  db.query(
    `UPDATE conversations SET holds = holds + 1,
       hold_whys = json_insert(CASE WHEN json_array_length(hold_whys) >= ?2 THEN json_remove(hold_whys, '$[0]') ELSE hold_whys END, '$[#]', ?1)
     WHERE identity_id = ?3 AND venue_id = ?4 AND thread_root_id = ?5`,
  ).run(why, HOLD_WHY_KEEP, identityId, venueId, rootKey(threadRootId));
}

// An ear wake verdict's why — her own first read of the conversation, durable instead of the
// consumed-once RAM note that died on restart and missed any wake it didn't trigger.
export function recordWakeWhy(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null, why: string): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  db.query("UPDATE conversations SET wake_why = ? WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?").run(
    why,
    identityId,
    venueId,
    rootKey(threadRootId),
  );
}

// Delivery reads the judgment WITH the messages and settles it: rendering a conversation into a
// wake consumes its accumulated holds/wake-why (they described the undelivered stretch now being
// delivered) and advances its watermark. One transaction — a wake structurally cannot take the
// messages and leave the judgment behind.
export function consumeJudgments(
  db: Database,
  clock: Clock,
  identityId: string,
  conversations: { venueId: string; threadRootId: string | null }[],
  deliveredRowid: number,
): ConversationJudgment[] {
  const out: ConversationJudgment[] = [];
  const tx = db.transaction(() => {
    for (const c of conversations) {
      ensureConversation(db, clock, identityId, c.venueId, c.threadRootId);
      const row = db
        .query("SELECT holds, hold_whys, wake_why FROM conversations WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?")
        .get(identityId, c.venueId, rootKey(c.threadRootId)) as { holds: number; hold_whys: string; wake_why: string | null };
      out.push({ venueId: c.venueId, threadRootId: c.threadRootId, holds: row.holds, holdWhys: JSON.parse(row.hold_whys) as string[], wakeWhy: row.wake_why });
      db.query(
        `UPDATE conversations SET holds = 0, hold_whys = '[]', wake_why = NULL,
           delivered_rowid = max(delivered_rowid, ?), judged_rowid = max(judged_rowid, ?)
         WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?`,
      ).run(deliveredRowid, deliveredRowid, identityId, c.venueId, rootKey(c.threadRootId));
    }
  });
  tx();
  return out;
}

export function getConversationJudgment(db: Database, identityId: string, venueId: string, threadRootId: string | null): ConversationJudgment | null {
  const row = db
    .query("SELECT holds, hold_whys, wake_why FROM conversations WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?")
    .get(identityId, venueId, rootKey(threadRootId)) as { holds: number; hold_whys: string; wake_why: string | null } | null;
  return row
    ? { venueId, threadRootId, holds: row.holds, holdWhys: JSON.parse(row.hold_whys) as string[], wakeWhy: row.wake_why }
    : null;
}
