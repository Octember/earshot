// One room, one row (specs/2026-08-10-one-room-redesign.md): the conversation — one row per
// (identity, venue, thread root) — is THE unit of delivery, judgment, and standing. This module
// owns all three, plus the ONE renderer both readers (the ear and the mind) see conversations
// through. The 07/09–08/10 incident catalog is one bug twelve ways: a fact one decision-maker
// held was invisible to the next. Here the row holds the facts and the renderer is the only
// door, so the classes die structurally:
//   - per-conversation watermarks: an unrelated wake cannot drain another conversation's held
//     messages (they deliver only with their own row, judgment attached)
//   - holds/wake-why consumed WITH delivery in one transaction: a wake cannot take the messages
//     and leave the ear's reads behind
//   - stance ('engaged'/'out') absorbs SPEC §5.1 participation and step-back: out-stance
//     observed chatter waits, undelivered, until a mention or her own post re-engages
//   - acts (her posts/reactions) interleave into the same rendered transcript, so "she can't
//     see her own words" is unrepresentable
// A null thread root (top-level channel surface) normalizes to '' for the primary key.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import type { InboxMessage } from "./inbox";

const HOLD_WHY_KEEP = 4; // bounded history — never a single latest-wins why (a stale one would render as live fact)
const TAIL_LIMIT = 8;

export type Stance = "none" | "engaged" | "out";

export interface ConversationKey {
  venueId: string;
  threadRootId: string | null;
}

export interface ConversationJudgment extends ConversationKey {
  holds: number;
  holdWhys: string[];
  wakeWhy: string | null;
}

export interface StanceState {
  stance: Stance;
  why: string | null;
  at: string | null;
}

export interface PendingConversation extends ConversationKey {
  stance: StanceState;
  messages: InboxMessage[];
}

export function rootKey(threadRootId: string | null): string {
  return threadRootId ?? "";
}

export function convoKey(venueId: string, threadRootId: string | null): string {
  return `${venueId}|${rootKey(threadRootId)}`;
}

export function ensureConversation(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null): void {
  db.query(
    "INSERT INTO conversations (identity_id, venue_id, thread_root_id, first_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(identityId, venueId, rootKey(threadRootId), clock());
}

// SPEC §5.1 both halves — a mention/addressed message or her own outbound post — engage the
// conversation (and clear any step-back: a mention always wins, and a deliberate post after
// the reply gate's card is her informed re-entry).
export function engage(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  db.query("UPDATE conversations SET stance = 'engaged', stance_why = NULL, stance_at = ? WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?").run(
    clock(),
    identityId,
    venueId,
    rootKey(threadRootId),
  );
}

// Her judgment to leave. Replies there stop delivering (and stop classifying thread_follow)
// until re-engaged; the why is durable and renders whenever the conversation next reaches her.
export function stepBack(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null, why: string): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  db.query("UPDATE conversations SET stance = 'out', stance_why = ?, stance_at = ? WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?").run(
    why,
    clock(),
    identityId,
    venueId,
    rootKey(threadRootId),
  );
}

export function stanceOf(db: Database, identityId: string, venueId: string, threadRootId: string | null): StanceState {
  const row = db
    .query("SELECT stance, stance_why, stance_at FROM conversations WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?")
    .get(identityId, venueId, rootKey(threadRootId)) as { stance: Stance; stance_why: string | null; stance_at: string | null } | null;
  return row ? { stance: row.stance, why: row.stance_why, at: row.stance_at } : { stance: "none", why: null, at: null };
}

// Every venue the ledger knows a thread root by — heard messages plus her own established
// conversations. A thread root ts is only meaningful within its venue; callers use this to
// catch a threadRootId paired with the wrong venue before posting.
export function venuesForThread(db: Database, threadRootId: string): string[] {
  const rows = db
    .query(
      `SELECT venue_id FROM events
        WHERE venue_id IS NOT NULL AND (thread_root_id = ? OR json_extract(payload, '$.ts') = ?)
       UNION
       SELECT venue_id FROM conversations WHERE thread_root_id = ?`,
    )
    .all(threadRootId, threadRootId, threadRootId) as { venue_id: string }[];
  return rows.map((r) => r.venue_id);
}

// A reply's arrival re-homes its root: the top-level message that started the thread stops
// being venue-surface traffic and becomes the thread's first message, durably — every reader's
// SQL then agrees on membership. Deliveredness carries over: a root the surface conversation
// already delivered must not re-deliver as fresh traffic under its new home (it would arrive as
// a stale mention and flip a later wake's addressed duties — observed in test as a broken §5.5).
export function rehomeThreadRoot(db: Database, clock: Clock, identityId: string, venueId: string, rootTs: string): void {
  const root = db
    .query(
      "SELECT rowid FROM events WHERE identity_id = ? AND venue_id = ? AND thread_root_id IS NULL AND json_extract(payload, '$.ts') = ?",
    )
    .get(identityId, venueId, rootTs) as { rowid: number } | null;
  if (!root) return;
  db.transaction(() => {
    db.query("UPDATE events SET thread_root_id = ? WHERE rowid = ?").run(rootTs, root.rowid);
    const surface = db
      .query("SELECT delivered_rowid, judged_rowid FROM conversations WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ''")
      .get(identityId, venueId) as { delivered_rowid: number; judged_rowid: number } | null;
    if (!surface) return;
    ensureConversation(db, clock, identityId, venueId, rootTs);
    // Judgment the ear pinned to the surface while the root lived there moves with it — but
    // only when the root was the surface's sole undelivered message (then the reads
    // demonstrably described it; otherwise they stay, describing the rest).
    const otherUndelivered = db
      .query(
        `SELECT 1 FROM events WHERE identity_id = ? AND venue_id = ? AND thread_root_id IS NULL
          AND kind IN ${DELIVERABLE_KINDS} AND rowid > ? LIMIT 1`,
      )
      .get(identityId, venueId, surface.delivered_rowid);
    if (surface.delivered_rowid < root.rowid && !otherUndelivered) {
      const j = db
        .query("SELECT holds, hold_whys, wake_why FROM conversations WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ''")
        .get(identityId, venueId) as { holds: number; hold_whys: string; wake_why: string | null };
      if (j.holds > 0 || j.wake_why) {
        db.query("UPDATE conversations SET holds = ?, hold_whys = ?, wake_why = ? WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?").run(
          j.holds,
          j.hold_whys,
          j.wake_why,
          identityId,
          venueId,
          rootTs,
        );
        db.query("UPDATE conversations SET holds = 0, hold_whys = '[]', wake_why = NULL WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ''").run(
          identityId,
          venueId,
        );
      }
    }
    if (surface.delivered_rowid >= root.rowid) {
      db.query("UPDATE conversations SET delivered_rowid = max(delivered_rowid, ?) WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?").run(
        root.rowid,
        identityId,
        venueId,
        rootTs,
      );
    }
    if (surface.judged_rowid >= root.rowid) {
      db.query("UPDATE conversations SET judged_rowid = max(judged_rowid, ?) WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?").run(
        root.rowid,
        identityId,
        venueId,
        rootTs,
      );
    }
  })();
}

// --- judgment -------------------------------------------------------------------------------

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

// An ear wake verdict's why — her own first read of the conversation, durable.
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
// wake consumes its accumulated holds/wake-why (they described the stretch now being delivered)
// and advances its watermark. One transaction — messages and judgment are inseparable.
export function consumeJudgment(db: Database, clock: Clock, identityId: string, key: ConversationKey, deliveredRowid: number): ConversationJudgment {
  let out: ConversationJudgment;
  db.transaction(() => {
    ensureConversation(db, clock, identityId, key.venueId, key.threadRootId);
    const row = db
      .query("SELECT holds, hold_whys, wake_why FROM conversations WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?")
      .get(identityId, key.venueId, rootKey(key.threadRootId)) as { holds: number; hold_whys: string; wake_why: string | null };
    out = { ...key, holds: row.holds, holdWhys: JSON.parse(row.hold_whys) as string[], wakeWhy: row.wake_why };
    // Delivery advances ONLY its own watermark: the ear's judged cursor may trail so it can
    // still bookkeep addressed traffic after the fact (debts on asks she was woken for).
    db.query(
      `UPDATE conversations SET holds = 0, hold_whys = '[]', wake_why = NULL,
         delivered_rowid = max(delivered_rowid, ?)
       WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?`,
    ).run(deliveredRowid, identityId, key.venueId, rootKey(key.threadRootId));
  })();
  return out!;
}

export function getConversationJudgment(db: Database, identityId: string, venueId: string, threadRootId: string | null): ConversationJudgment | null {
  const row = db
    .query("SELECT holds, hold_whys, wake_why FROM conversations WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?")
    .get(identityId, venueId, rootKey(threadRootId)) as { holds: number; hold_whys: string; wake_why: string | null } | null;
  return row
    ? { venueId, threadRootId, holds: row.holds, holdWhys: JSON.parse(row.hold_whys) as string[], wakeWhy: row.wake_why }
    : null;
}

// --- delivery -------------------------------------------------------------------------------

const DELIVERABLE_KINDS = "('addressed_message','observed_message','external_signal')";

function messagesOf(rows: { rowid: number; id: string; kind: string; venue_id: string | null; thread_root_id: string | null; principal_id: string | null; payload: string; received_at: string }[]): InboxMessage[] {
  return rows.map((r) => {
    const p = JSON.parse(r.payload) as { text?: string; ts?: string; principalName?: string; addressMode?: InboxMessage["addressMode"]; files?: InboxMessage["files"] };
    return {
      rowid: r.rowid,
      id: r.id,
      kind: r.kind as InboxMessage["kind"],
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

// Undelivered traffic, grouped by conversation, each with its standing. Out-stance conversations
// hold their OBSERVED chatter back — her recorded choice to leave, not a cheap-tier judgment —
// while an addressed message re-engaged the stance at ingest (router), so a mention is never
// held. Conversations orderd oldest-undelivered first; messages in rowid order within each.
// Grouping is exactly the SQL join's rule — a message's home is its thread_root_id (the router
// re-homes a thread's root event into the thread at the first reply's ingest, so membership
// never depends on batch composition; a re-homed root that was already delivered as surface
// chatter re-delivers ONCE as its thread's first message, which is honest: the thread is new).
function groupByConversation(db: Database, identityId: string, messages: InboxMessage[]): PendingConversation[] {
  const grouped = new Map<string, PendingConversation>();
  for (const m of messages) {
    const key = convoKey(m.venueId!, m.threadRootId);
    let g = grouped.get(key);
    if (!g) {
      g = { venueId: m.venueId!, threadRootId: m.threadRootId, stance: stanceOf(db, identityId, m.venueId!, m.threadRootId), messages: [] };
      grouped.set(key, g);
    }
    g.messages.push(m);
  }
  return [...grouped.values()];
}

const OUT_STANCE_EXCEPTIONS = "(ifnull(c.stance, 'none') != 'out' OR e.kind = 'external_signal' OR c.wake_why IS NOT NULL)";

export function pendingConversations(db: Database, identityId: string, limit = 200): PendingConversation[] {
  const rows = db
    .query(
      `SELECT e.rowid, e.id, e.kind, e.venue_id, e.thread_root_id, e.principal_id, e.payload, e.received_at
         FROM events e
         LEFT JOIN conversations c ON c.identity_id = e.identity_id AND c.venue_id = e.venue_id AND c.thread_root_id = ifnull(e.thread_root_id, '')
        WHERE e.identity_id = ? AND e.kind IN ${DELIVERABLE_KINDS} AND e.venue_id IS NOT NULL
          AND e.rowid > ifnull(c.delivered_rowid, 0)
          AND ${OUT_STANCE_EXCEPTIONS}
        ORDER BY e.rowid LIMIT ?`,
    )
    .all(identityId, limit) as Parameters<typeof messagesOf>[0];
  const direct = db
    .query(
      `SELECT e.rowid, e.id, e.kind, e.venue_id, e.thread_root_id, e.principal_id, e.payload, e.received_at
         FROM events e
         LEFT JOIN conversations c ON c.identity_id = e.identity_id AND c.venue_id = e.venue_id AND c.thread_root_id = ifnull(e.thread_root_id, '')
        WHERE e.identity_id = ? AND e.kind = 'addressed_message' AND e.venue_id IS NOT NULL
          AND e.rowid > ifnull(c.delivered_rowid, 0)
          AND json_extract(e.payload, '$.addressMode') IN ('mention', 'dm')
        ORDER BY e.rowid`,
    )
    .all(identityId) as Parameters<typeof messagesOf>[0];
  const seen = new Set(rows.map((r) => r.rowid));
  const merged = [...rows, ...direct.filter((r) => !seen.has(r.rowid))].sort((a, b) => a.rowid - b.rowid);
  return groupByConversation(db, identityId, messagesOf(merged));
}

export function hasUndelivered(db: Database, identityId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM events e
           LEFT JOIN conversations c ON c.identity_id = e.identity_id AND c.venue_id = e.venue_id AND c.thread_root_id = ifnull(e.thread_root_id, '')
          WHERE e.identity_id = ? AND e.kind IN ${DELIVERABLE_KINDS} AND e.venue_id IS NOT NULL
            AND e.rowid > ifnull(c.delivered_rowid, 0)
            AND ${OUT_STANCE_EXCEPTIONS}
          LIMIT 1`,
      )
      .get(identityId) !== null
  );
}

// The ear's side of the same rows: unjudged traffic per conversation, EVERY stance included —
// the ear listens to rooms she has left too (an emergency there should still wake her; her
// stance gates delivery, never the listening).
export function unjudgedConversations(db: Database, identityId: string, limit = 200): PendingConversation[] {
  const rows = db
    .query(
      `SELECT e.rowid, e.id, e.kind, e.venue_id, e.thread_root_id, e.principal_id, e.payload, e.received_at
         FROM events e
         LEFT JOIN conversations c ON c.identity_id = e.identity_id AND c.venue_id = e.venue_id AND c.thread_root_id = ifnull(e.thread_root_id, '')
        WHERE e.identity_id = ? AND e.kind IN ${DELIVERABLE_KINDS} AND e.venue_id IS NOT NULL
          AND e.rowid > ifnull(c.judged_rowid, 0)
        ORDER BY e.rowid LIMIT ?`,
    )
    .all(identityId, limit) as Parameters<typeof messagesOf>[0];
  return groupByConversation(db, identityId, messagesOf(rows));
}

export function hasUnjudged(db: Database, identityId: string): boolean {
  return (
    db
      .query(
        `SELECT 1 FROM events e
           LEFT JOIN conversations c ON c.identity_id = e.identity_id AND c.venue_id = e.venue_id AND c.thread_root_id = ifnull(e.thread_root_id, '')
          WHERE e.identity_id = ? AND e.kind IN ${DELIVERABLE_KINDS} AND e.venue_id IS NOT NULL
            AND e.rowid > ifnull(c.judged_rowid, 0)
          LIMIT 1`,
      )
      .get(identityId) !== null
  );
}

// Judged or punted, these rows are the ear's past now. Monotonic (max), and free to trail
// delivered — the ear bookkeeps addressed traffic after the fact.
export function advanceJudged(db: Database, clock: Clock, identityId: string, key: ConversationKey, judgedRowid: number): void {
  ensureConversation(db, clock, identityId, key.venueId, key.threadRootId);
  db.query(
    "UPDATE conversations SET judged_rowid = max(judged_rowid, ?) WHERE identity_id = ? AND venue_id = ? AND thread_root_id = ?",
  ).run(judgedRowid, identityId, key.venueId, rootKey(key.threadRootId));
}

// --- her own voice ---------------------------------------------------------------------------

export interface Act {
  kind: "posted" | "reacted";
  venueId: string;
  threadRootId: string | null;
  ts: string | null; // posted: the message's own ts; reacted: the message reacted TO
  text: string | null; // posted: the text; reacted: the emoji name
  at: string;
}

// Records an outward act in the same breath as the adapter call. inserted=false means this wake
// already recorded the same act — a retry attempt re-running an identical outward call is a
// no-op instead of a double post (UNIQUE(wake_id, act_key); the effects-nonempty retry guard
// remains the first line of defense). The surface ts (a post's own message id) arrives after
// the adapter call — setActTs backfills it so the renderer can interleave by time.
export function recordAct(
  db: Database,
  clock: Clock,
  identityId: string,
  wakeId: string,
  act: { kind: "posted" | "reacted"; venueId: string; threadRootId: string | null; ts: string | null; text: string | null },
): { inserted: boolean; actKey: string } {
  const actKey = `${act.kind}:${act.venueId}:${rootKey(act.threadRootId)}:${act.text ?? ""}:${act.kind === "reacted" ? act.ts : ""}`;
  const result = db
    .query(
      `INSERT INTO acts (wake_id, act_key, identity_id, kind, venue_id, thread_root_id, ts, text, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
    )
    .run(wakeId, actKey, identityId, act.kind, act.venueId, act.threadRootId, act.ts, act.text, clock());
  return { inserted: result.changes > 0, actKey };
}

// Fills the surface ts once the adapter call returns — and for a TOP-LEVEL post, homes the act
// into the thread that post just rooted (the conversation engage() keys on the message id): her
// own opening message must render in the thread it started, not on the venue surface.
export function setActTs(db: Database, wakeId: string, actKey: string, ts: string, threadRootId?: string | null): void {
  if (threadRootId !== undefined) {
    db.query("UPDATE acts SET ts = ?, thread_root_id = ? WHERE wake_id = ? AND act_key = ?").run(ts, threadRootId, wakeId, actKey);
  } else {
    db.query("UPDATE acts SET ts = ? WHERE wake_id = ? AND act_key = ?").run(ts, wakeId, actKey);
  }
}

// Compensating delete: an act records INTENT before the adapter call for retry idempotency; if
// the adapter call itself fails, the intent must not survive to poison the retry (a swallowed
// second attempt would report success for a reaction that never landed) or to render in her
// tail as something she said.
export function deleteAct(db: Database, wakeId: string, actKey: string): void {
  db.query("DELETE FROM acts WHERE wake_id = ? AND act_key = ?").run(wakeId, actKey);
}

// --- withheld drafts (§5.5), durable --------------------------------------------------------

export function saveDraft(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null, text: string): void {
  db.query("INSERT INTO drafts (identity_id, venue_id, thread_root_id, text, drafted_at) VALUES (?, ?, ?, ?, ?)").run(
    identityId,
    venueId,
    threadRootId,
    text,
    clock(),
  );
}

// §5.5: a withheld reply surfaces to the immediately following wake. Reading is a PEEK —
// consumption commits in the wake's finally, scoped to EXACTLY the rows peeked (a wake also
// SAVES drafts mid-turn via the withhold path; a blanket identity-wide stamp would eat its own
// withholds before any wake rendered them — review finding, 2026-08-11) and only for a
// SUCCEEDED turn (a failed wake returns its drafts to the next one instead of eating them).
export function peekDrafts(db: Database, identityId: string): { id: number; venueId: string; threadRootId: string | null; text: string }[] {
  const rows = db
    .query("SELECT id, venue_id, thread_root_id, text FROM drafts WHERE identity_id = ? AND consumed_at IS NULL ORDER BY id")
    .all(identityId) as { id: number; venue_id: string; thread_root_id: string | null; text: string }[];
  return rows.map((r) => ({ id: r.id, venueId: r.venue_id, threadRootId: r.thread_root_id, text: r.text }));
}

export function markDraftsConsumed(db: Database, clock: Clock, identityId: string, ids: number[]): void {
  if (ids.length === 0) return;
  const marks = ids.map(() => "?").join(",");
  db.query(`UPDATE drafts SET consumed_at = ? WHERE identity_id = ? AND id IN (${marks})`).run(clock(), identityId, ...ids);
}

// The newest deliverable event a conversation has — the bounce card's "delivered through here".
export function maxEventRowid(db: Database, identityId: string, venueId: string, threadRootId: string | null): number {
  const row = (
    threadRootId
      ? db
          .query(
            `SELECT max(rowid) AS r FROM events WHERE identity_id = ? AND venue_id = ? AND kind IN ${DELIVERABLE_KINDS}
              AND (thread_root_id = ? OR json_extract(payload, '$.ts') = ?)`,
          )
          .get(identityId, venueId, threadRootId, threadRootId)
      : db
          .query(`SELECT max(rowid) AS r FROM events WHERE identity_id = ? AND venue_id = ? AND kind IN ${DELIVERABLE_KINDS} AND thread_root_id IS NULL`)
          .get(identityId, venueId)
  ) as { r: number | null };
  return row.r ?? 0;
}

// --- refs: addressing as capability -----------------------------------------------------------
//
// The model never composes (venue, thread) coordinates: the renderer MINTS an opaque ref for
// every conversation and message it shows, and the speaking tools accept refs only. A
// coordinate the turn was never shown cannot be constructed — hallucinated thread ids,
// cross-channel ts reuse, and posting-into-unread stop being behaviors to catch (ladder R4).
// `via` records provenance: 'rendered' targets were read this turn and may be spoken into
// freely; 'search' targets (search hits, withheld drafts, owed items) bounce once with the
// conversation's card before a send goes through.

export interface RefTarget {
  venueId: string;
  threadRootId: string | null;
  ts?: string; // present on message refs — the message's own surface ts
  via: "rendered" | "search";
  // Provenance, when the renderer knew it at mint time: the exact event behind the line and who
  // spoke it. Durable writes (a task's sponsor/origin, a confirmation's approver) bind to these
  // — never to any batch-level "whoever addressed her last" pick (T-354's second half).
  eventId?: string;
  principalId?: string | null;
}

export interface RefTable {
  mint(target: RefTarget): string;
  get(ref: string): RefTarget | undefined;
}

export function makeRefTable(): RefTable {
  let n = 0;
  const table = new Map<string, RefTarget>();
  return {
    mint(target) {
      const ref = `r${++n}`;
      table.set(ref, target);
      return ref;
    },
    get: (ref) => table.get(ref),
  };
}

// A message ref names the conversation a reply to it lands in: its thread, or (for a top-level
// message) the thread it roots.
export function conversationOf(t: RefTarget): ConversationKey {
  return { venueId: t.venueId, threadRootId: t.threadRootId ?? t.ts ?? null };
}

// The event (and speaker) a ref stands on, for durable writes. Renderer-minted refs carry it;
// for the rest (search refs, older mints) it resolves from the ledger: the exact event when the
// ref names a message, else the newest event IN the ref's conversation — always within the
// conversation the model chose, never across the batch. Null when the conversation has no
// recorded events (nothing to bind to — callers bounce rather than guess).
export function provenanceOfRef(db: Database, identityId: string, t: RefTarget): { eventId: string; principalId: string | null } | null {
  if (t.eventId) return { eventId: t.eventId, principalId: t.principalId ?? null };
  if (t.ts) {
    const exact = db
      .query(
        `SELECT id, principal_id FROM events
          WHERE identity_id = ? AND venue_id = ? AND json_extract(payload, '$.ts') = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(identityId, t.venueId, t.ts) as { id: string; principal_id: string | null } | null;
    if (exact) return { eventId: exact.id, principalId: exact.principal_id };
  }
  const key = conversationOf(t);
  const row = (
    key.threadRootId
      ? db
          .query(
            `SELECT id, principal_id FROM events
              WHERE identity_id = ? AND venue_id = ?
                AND kind IN ('addressed_message','observed_message','external_signal')
                AND (thread_root_id = ? OR json_extract(payload, '$.ts') = ?)
              ORDER BY rowid DESC LIMIT 1`,
          )
          .get(identityId, key.venueId, key.threadRootId, key.threadRootId)
      : db
          .query(
            `SELECT id, principal_id FROM events
              WHERE identity_id = ? AND venue_id = ?
                AND kind IN ('addressed_message','observed_message','external_signal')
                AND thread_root_id IS NULL
              ORDER BY rowid DESC LIMIT 1`,
          )
          .get(identityId, key.venueId)
  ) as { id: string; principal_id: string | null } | null;
  return row ? { eventId: row.id, principalId: row.principal_id } : null;
}

// The newest HUMAN speaker in a conversation — the sponsor fallback when a ref's own line is
// machine-authored (a worker report has no principal). Scoped to the conversation the model
// chose; never a batch-level pick.
export function lastSpeakerIn(db: Database, identityId: string, key: ConversationKey): string | null {
  const row = (
    key.threadRootId
      ? db
          .query(
            `SELECT principal_id FROM events
              WHERE identity_id = ? AND venue_id = ? AND principal_id IS NOT NULL
                AND (thread_root_id = ? OR json_extract(payload, '$.ts') = ?)
              ORDER BY rowid DESC LIMIT 1`,
          )
          .get(identityId, key.venueId, key.threadRootId, key.threadRootId)
      : db
          .query(
            `SELECT principal_id FROM events
              WHERE identity_id = ? AND venue_id = ? AND principal_id IS NOT NULL
                AND thread_root_id IS NULL
              ORDER BY rowid DESC LIMIT 1`,
          )
          .get(identityId, key.venueId)
  ) as { principal_id: string } | null;
  return row?.principal_id ?? null;
}

// --- the one renderer ------------------------------------------------------------------------

interface TailLine {
  sortTs: number;
  surfaceTs: string | null; // their messages carry one (a ref target); her acts render bare
  line: string; // formatted WITHOUT a ref prefix — the renderer prepends the minted ref
  eventId?: string; // provenance for the minted ref (their messages only)
  principalId?: string | null;
}

function who(p: { principalId: string | null; principalName?: string }): string {
  return `<@${p.principalId ?? "?"}>${p.principalName ? ` (${p.principalName})` : ""}`;
}

// A delivered message, verbatim, with the coordinates that let her PLACE it (venue, thread,
// ts stay visible for reading) — addressing runs on refs, never on these strings.
export function inboxLine(m: InboxMessage): string {
  const files = m.files?.length
    ? ` [attached: ${m.files.map((f) => `${f.name}${f.mimetype ? ` (${f.mimetype})` : ""}${f.urlPrivate ? ` url_private=${f.urlPrivate}` : ""}`).join(", ")}]`
    : "";
  return `[<#${m.venueId}>${m.threadRootId ? ` thread=${m.threadRootId}` : ""} ts=${m.ts}] ${who(m)}: ${m.text.slice(0, 2500)}${files}`;
}

// The already-heard tail: events (theirs) and acts (hers) merged in time order. Her words in
// place is what makes a fresh session's read of a conversation complete — the class of "she
// answers blind to what she already said" dies here, not in a digest.
function tailOf(db: Database, identityId: string, key: ConversationKey, beforeRowid: number, selfLabel: string): TailLine[] {
  // A thread's tail is its replies plus its root message (a reply carries thread_root_id, the
  // root is its own ts — same OR-match the router uses). The venue surface's tail is its recent
  // top-level messages.
  const events = (
    key.threadRootId
      ? db
          .query(
            `SELECT id, principal_id, json_extract(payload, '$.text') AS text, json_extract(payload, '$.principalName') AS name,
                    json_extract(payload, '$.ts') AS ts
               FROM events
              WHERE identity_id = ? AND venue_id = ? AND rowid <= ?
                AND kind IN ('addressed_message','observed_message')
                AND (thread_root_id = ? OR json_extract(payload, '$.ts') = ?)
              ORDER BY rowid DESC LIMIT ?`,
          )
          .all(identityId, key.venueId, beforeRowid, key.threadRootId, key.threadRootId, TAIL_LIMIT)
      : db
          .query(
            `SELECT id, principal_id, json_extract(payload, '$.text') AS text, json_extract(payload, '$.principalName') AS name,
                    json_extract(payload, '$.ts') AS ts
               FROM events
              WHERE identity_id = ? AND venue_id = ? AND rowid <= ?
                AND kind IN ('addressed_message','observed_message')
                AND thread_root_id IS NULL
              ORDER BY rowid DESC LIMIT ?`,
          )
          .all(identityId, key.venueId, beforeRowid, TAIL_LIMIT)
  ) as {
    id: string;
    principal_id: string | null;
    text: string | null;
    name: string | null;
    ts: string | null;
  }[];
  const theirs: TailLine[] = events.reverse().map((r) => ({
    sortTs: r.ts ? Number(r.ts) : 0,
    surfaceTs: r.ts,
    eventId: r.id,
    principalId: r.principal_id,
    line: `${who({ principalId: r.principal_id, ...(r.name ? { principalName: r.name } : {}) })}: ${(r.text ?? "").slice(0, 300)}`,
  }));
  const acts = db
    .query(
      `SELECT kind, ts, text, at FROM acts
        WHERE identity_id = ? AND venue_id = ? AND thread_root_id IS ?
        ORDER BY id DESC LIMIT ?`,
    )
    .all(identityId, key.venueId, key.threadRootId, TAIL_LIMIT) as { kind: "posted" | "reacted"; ts: string | null; text: string | null; at: string }[];
  const hers: TailLine[] = acts.reverse().map((a) => ({
    sortTs: a.ts ? Number(a.ts) : Date.parse(a.at) / 1000,
    surfaceTs: null,
    line: a.kind === "posted" ? `${selfLabel}: ${(a.text ?? "").slice(0, 300)}` : `${selfLabel} reacted :${a.text}: to ts=${a.ts}`,
  }));
  return [...theirs, ...hers].sort((a, b) => a.sortTs - b.sortTs).slice(-TAIL_LIMIT);
}

export interface RenderOpts {
  // The new messages this render delivers; the renderer formats and ref-tags every line. mark
  // frames how a line reached her ("[to you] ", the ear's "[she was woken for this] ") — the
  // framing differs between readers, the conversation body never does.
  newMessages: InboxMessage[];
  mark?: (m: InboxMessage) => string;
  judgment?: ConversationJudgment;
  stance?: StanceState;
  // Tail cutoff: rows at or before this rowid are "already heard". Callers pass the rowid just
  // below their batch so the tail never duplicates the new lines.
  beforeRowid: number;
  // How her own acts read in the tail: the mind sees "you", the ear sees "she". Header lines
  // stay subject-free so both voices read naturally.
  selfLabel?: "you" | "she";
  // When present, the renderer MINTS a ref for the conversation and for every message line it
  // emits — the only source of addressable targets for the speaking tools (ladder R4).
  refs?: RefTable;
}

// THE renderer — the only way a conversation enters any prompt, and (via refs) the only source
// of addresses a turn can speak to. The conversation line always opens the card: it carries the
// conversation's ref and any standing/judgment; a fresh conversation's line is just the address.
export function renderConversation(db: Database, identityId: string, key: ConversationKey, opts: RenderOpts): string {
  const where = `<#${key.venueId}>${key.threadRootId ? ` thread=${key.threadRootId}` : ""}`;
  const selfLabel = opts.selfLabel ?? "you";
  const mark = opts.mark ?? (() => "");
  const headerBits: string[] = [];
  if (opts.stance?.stance === "out") {
    headerBits.push(`stepped out of this conversation${opts.stance.at ? ` at ${opts.stance.at}` : ""}${opts.stance.why ? ` — "${opts.stance.why}"` : ""}`);
  }
  if (opts.judgment && opts.judgment.holds > 0) {
    headerBits.push(`the ear held it ${opts.judgment.holds}x without a wake: ${opts.judgment.holdWhys.map((w) => `"${w}"`).join("; ")}`);
  }
  if (opts.judgment?.wakeWhy) {
    headerBits.push(`first read: ${opts.judgment.wakeWhy}`);
  }
  // A conversation ref carries the provenance of its newest delivered line (who asked, which
  // event) so durable writes through a conversation-level ref still bind inside the right room.
  const lastNew = opts.newMessages.at(-1);
  const cref = opts.refs?.mint({
    venueId: key.venueId,
    threadRootId: key.threadRootId,
    via: "rendered",
    ...(lastNew ? { eventId: lastNew.id, principalId: lastNew.principalId } : {}),
  });
  const address = cref ? `${cref} ${where}` : where;
  const header = headerBits.length || cref ? `[${address}${headerBits.length ? `: ${headerBits.join(" | ")}` : ""}]\n` : "";
  const tag = (surfaceTs: string | null, eventId?: string, principalId?: string | null): string => {
    if (!opts.refs || !surfaceTs) return "";
    return `[${opts.refs.mint({
      venueId: key.venueId,
      threadRootId: key.threadRootId,
      ts: surfaceTs,
      via: "rendered",
      ...(eventId ? { eventId } : {}),
      ...(principalId !== undefined ? { principalId } : {}),
    })}] `;
  };
  const tail = tailOf(db, identityId, key, opts.beforeRowid, selfLabel);
  const tailBlock = tail.length
    ? `earlier in ${where} (already heard — so you can tell who is talking to whom):\n${tail.map((t) => `  ${tag(t.surfaceTs, t.eventId, t.principalId)}${t.line}`).join("\n")}\n`
    : "";
  const newLines = opts.newMessages.map((m) => `${tag(m.ts, m.id, m.principalId)}${mark(m)}${inboxLine(m)}`).join("\n");
  return `${header}${tailBlock}${newLines}`;
}

