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
import { and, asc, desc, eq, inArray, isNotNull, isNull, max, or, sql } from "drizzle-orm";
import { asString, isRecord, parseJson } from "../guard";
import type { Clock } from "./clock";
import { orm } from "./db";
import { acts, conversations, drafts, events, type Stance } from "./schema";
import type { InboxMessage } from "./inbox";

export type { Stance };

const HOLD_WHY_KEEP = 4; // bounded history — never a single latest-wins why (a stale one would render as live fact)
const TAIL_LIMIT = 8;

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

const eventCols = {
  rowid: sql<number>`${events}.rowid`.as("rowid"),
  id: events.id,
  kind: events.kind,
  venueId: events.venueId,
  threadRootId: events.threadRootId,
  principalId: events.principalId,
  payload: events.payload,
  receivedAt: events.receivedAt,
};

function convoEq(identityId: string, venueId: string, threadRootId: string | null) {
  return and(eq(conversations.identityId, identityId), eq(conversations.venueId, venueId), eq(conversations.threadRootId, rootKey(threadRootId)));
}

function sameNullable(column: typeof events.threadRootId | typeof acts.threadRootId, value: string | null) {
  return value === null ? isNull(column) : eq(column, value);
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function asInboxKind(v: string): InboxMessage["kind"] {
  return v === "addressed_message" || v === "external_signal" ? v : "observed_message";
}

function asAddressMode(v: unknown): InboxMessage["addressMode"] | undefined {
  return v === "mention" || v === "dm" || v === "thread_follow" ? v : undefined;
}

function parseFiles(v: unknown): InboxMessage["files"] {
  if (!Array.isArray(v)) return undefined;
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
  return files.length > 0 ? files : undefined;
}

function payloadOf(raw: unknown): {
  text: string;
  ts: string | null;
  principalName?: string;
  addressMode?: InboxMessage["addressMode"];
  files?: InboxMessage["files"];
} {
  const parsed = typeof raw === "string" ? parseJson(raw) : raw;
  const p = isRecord(parsed) ? parsed : {};
  const addressMode = asAddressMode(p.addressMode);
  const files = parseFiles(p.files);
  return {
    text: asString(p.text),
    ts: typeof p.ts === "string" ? p.ts : null,
    ...(typeof p.principalName === "string" ? { principalName: p.principalName } : {}),
    ...(addressMode ? { addressMode } : {}),
    ...(files?.length ? { files } : {}),
  };
}

function asStance(v: string): Stance {
  return v === "engaged" || v === "out" ? v : "none";
}

export function ensureConversation(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null): void {
  orm(db)
    .insert(conversations)
    .values({
      identityId,
      venueId,
      threadRootId: rootKey(threadRootId),
      firstAt: clock(),
      deliveredRowid: 0,
      judgedRowid: 0,
      holds: 0,
      holdWhys: [],
      wakeWhy: null,
      stance: "none",
      stanceWhy: null,
      stanceAt: null,
    })
    .onConflictDoNothing()
    .run();
}

// SPEC §5.1 both halves — a mention/addressed message or her own outbound post — engage the
// conversation (and clear any step-back: a mention always wins, and a deliberate post after
// the reply gate's card is her informed re-entry).
export function engage(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  orm(db)
    .update(conversations)
    .set({ stance: "engaged", stanceWhy: null, stanceAt: clock() })
    .where(convoEq(identityId, venueId, threadRootId))
    .run();
}

// Her judgment to leave. Replies there stop delivering (and stop classifying thread_follow)
// until re-engaged; the why is durable and renders whenever the conversation next reaches her.
export function stepBack(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null, why: string): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  orm(db)
    .update(conversations)
    .set({ stance: "out", stanceWhy: why, stanceAt: clock() })
    .where(convoEq(identityId, venueId, threadRootId))
    .run();
}

export function stanceOf(db: Database, identityId: string, venueId: string, threadRootId: string | null): StanceState {
  const row = orm(db)
    .select({ stance: conversations.stance, stanceWhy: conversations.stanceWhy, stanceAt: conversations.stanceAt })
    .from(conversations)
    .where(convoEq(identityId, venueId, threadRootId))
    .get();
  return row ? { stance: asStance(row.stance), why: row.stanceWhy, at: row.stanceAt } : { stance: "none", why: null, at: null };
}

// Every venue the ledger knows a thread root by — heard messages plus her own established
// conversations. A thread root ts is only meaningful within its venue; callers use this to
// catch a threadRootId paired with the wrong venue before posting.
export function venuesForThread(db: Database, threadRootId: string): string[] {
  const heard = orm(db)
    .select({ venueId: events.venueId })
    .from(events)
    .where(and(isNotNull(events.venueId), or(eq(events.threadRootId, threadRootId), sql`json_extract(${events.payload}, '$.ts') = ${threadRootId}`)))
    .all();
  const known = orm(db)
    .select({ venueId: conversations.venueId })
    .from(conversations)
    .where(eq(conversations.threadRootId, threadRootId))
    .all();
  return [...new Set([...heard, ...known].map((r) => r.venueId).filter((v): v is string => v !== null))];
}

// A reply's arrival re-homes its root: the top-level message that started the thread stops
// being venue-surface traffic and becomes the thread's first message, durably — every reader's
// SQL then agrees on membership. Deliveredness carries over: a root the surface conversation
// already delivered must not re-deliver as fresh traffic under its new home (it would arrive as
// a stale mention and flip a later wake's addressed duties — observed in test as a broken §5.5).
export function rehomeThreadRoot(db: Database, clock: Clock, identityId: string, venueId: string, rootTs: string): void {
  const root = orm(db)
    .select({ rowid: sql<number>`${events}.rowid` })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, venueId),
        isNull(events.threadRootId),
        sql`json_extract(${events.payload}, '$.ts') = ${rootTs}`,
      ),
    )
    .get();
  if (!root) return;
  db.transaction(() => {
    orm(db).update(events).set({ threadRootId: rootTs }).where(sql`${events}.rowid = ${root.rowid}`).run();
    const surface = orm(db)
      .select({ deliveredRowid: conversations.deliveredRowid, judgedRowid: conversations.judgedRowid })
      .from(conversations)
      .where(convoEq(identityId, venueId, ""))
      .get();
    if (!surface) return;
    ensureConversation(db, clock, identityId, venueId, rootTs);
    // Judgment the ear pinned to the surface while the root lived there moves with it — but
    // only when the root was the surface's sole undelivered message (then the reads
    // demonstrably described it; otherwise they stay, describing the rest).
    const otherUndelivered = orm(db)
      .select({ one: sql`1` })
      .from(events)
      .where(
        and(
          eq(events.identityId, identityId),
          eq(events.venueId, venueId),
          isNull(events.threadRootId),
          inArray(events.kind, ["addressed_message", "observed_message", "external_signal"]),
          sql`${events}.rowid > ${surface.deliveredRowid}`,
        ),
      )
      .limit(1)
      .get();
    if (surface.deliveredRowid < root.rowid && !otherUndelivered) {
      const j = orm(db)
        .select({ holds: conversations.holds, holdWhys: conversations.holdWhys, wakeWhy: conversations.wakeWhy })
        .from(conversations)
        .where(convoEq(identityId, venueId, ""))
        .get() ?? { holds: 0, holdWhys: [] as string[], wakeWhy: null };
      if (j.holds > 0 || j.wakeWhy) {
        orm(db)
          .update(conversations)
          .set({ holds: j.holds, holdWhys: j.holdWhys, wakeWhy: j.wakeWhy })
          .where(convoEq(identityId, venueId, rootTs))
          .run();
        orm(db)
          .update(conversations)
          .set({ holds: 0, holdWhys: [], wakeWhy: null })
          .where(convoEq(identityId, venueId, ""))
          .run();
      }
    }
    if (surface.deliveredRowid >= root.rowid) {
      orm(db)
        .update(conversations)
        .set({ deliveredRowid: sql`max(${conversations.deliveredRowid}, ${root.rowid})` })
        .where(convoEq(identityId, venueId, rootTs))
        .run();
    }
    if (surface.judgedRowid >= root.rowid) {
      orm(db)
        .update(conversations)
        .set({ judgedRowid: sql`max(${conversations.judgedRowid}, ${root.rowid})` })
        .where(convoEq(identityId, venueId, rootTs))
        .run();
    }
  })();
}

// --- judgment -------------------------------------------------------------------------------

// An ear hold: judged "nothing needed from her", durably. The why joins a bounded history so a
// conversation held four times renders four reads, not one stale latest.
export function recordHold(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null, why: string): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  orm(db)
    .update(conversations)
    .set({
      holds: sql`${conversations.holds} + 1`,
      holdWhys: sql`json_insert(CASE WHEN json_array_length(${conversations.holdWhys}) >= ${HOLD_WHY_KEEP} THEN json_remove(${conversations.holdWhys}, '$[0]') ELSE ${conversations.holdWhys} END, '$[#]', ${why})`,
    })
    .where(convoEq(identityId, venueId, threadRootId))
    .run();
}

// An ear wake verdict's why — her own first read of the conversation, durable.
export function recordWakeWhy(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null, why: string): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  orm(db).update(conversations).set({ wakeWhy: why }).where(convoEq(identityId, venueId, threadRootId)).run();
}

// Delivery reads the judgment WITH the messages and settles it: rendering a conversation into a
// wake consumes its accumulated holds/wake-why (they described the stretch now being delivered)
// and advances its watermark. One transaction — messages and judgment are inseparable.
export function consumeJudgment(db: Database, clock: Clock, identityId: string, key: ConversationKey, deliveredRowid: number): ConversationJudgment {
  let out: ConversationJudgment;
  db.transaction(() => {
    ensureConversation(db, clock, identityId, key.venueId, key.threadRootId);
    const row = orm(db)
      .select({ holds: conversations.holds, holdWhys: conversations.holdWhys, wakeWhy: conversations.wakeWhy })
      .from(conversations)
      .where(convoEq(identityId, key.venueId, key.threadRootId))
      .get() ?? { holds: 0, holdWhys: [] as string[], wakeWhy: null };
    out = { ...key, holds: row.holds, holdWhys: stringList(row.holdWhys), wakeWhy: row.wakeWhy };
    // Delivery advances ONLY its own watermark: the ear's judged cursor may trail so it can
    // still bookkeep addressed traffic after the fact (debts on asks she was woken for).
    orm(db)
      .update(conversations)
      .set({
        holds: 0,
        holdWhys: [],
        wakeWhy: null,
        deliveredRowid: sql`max(${conversations.deliveredRowid}, ${deliveredRowid})`,
      })
      .where(convoEq(identityId, key.venueId, key.threadRootId))
      .run();
  })();
  return out!;
}

export function getConversationJudgment(db: Database, identityId: string, venueId: string, threadRootId: string | null): ConversationJudgment | null {
  const row = orm(db)
    .select({ holds: conversations.holds, holdWhys: conversations.holdWhys, wakeWhy: conversations.wakeWhy })
    .from(conversations)
    .where(convoEq(identityId, venueId, threadRootId))
    .get();
  return row ? { venueId, threadRootId, holds: row.holds, holdWhys: stringList(row.holdWhys), wakeWhy: row.wakeWhy } : null;
}

// --- delivery -------------------------------------------------------------------------------

const DELIVERABLE_KINDS = ["addressed_message", "observed_message", "external_signal"] as const;

function convoJoin() {
  return and(
    eq(conversations.identityId, events.identityId),
    eq(conversations.venueId, events.venueId),
    eq(conversations.threadRootId, sql`ifnull(${events.threadRootId}, '')`),
  );
}

function outStanceExceptions() {
  return or(sql`ifnull(${conversations.stance}, 'none') != 'out'`, eq(events.kind, "external_signal"), isNotNull(conversations.wakeWhy));
}

function messagesOf(rows: ({ rowid: number } & Pick<typeof events.$inferSelect, "id" | "kind" | "venueId" | "threadRootId" | "principalId" | "payload" | "receivedAt">)[]): InboxMessage[] {
  return rows.map((r) => {
    const p = payloadOf(r.payload);
    return {
      rowid: r.rowid,
      id: r.id,
      kind: asInboxKind(r.kind),
      venueId: r.venueId,
      threadRootId: r.threadRootId,
      principalId: r.principalId,
      text: p.text,
      ts: p.ts,
      receivedAt: r.receivedAt,
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

export function pendingConversations(db: Database, identityId: string, limit = 200): PendingConversation[] {
  const rows = orm(db)
    .select(eventCols)
    .from(events)
    .leftJoin(conversations, convoJoin())
    .where(
      and(
        eq(events.identityId, identityId),
        inArray(events.kind, DELIVERABLE_KINDS),
        isNotNull(events.venueId),
        sql`${events}.rowid > ifnull(${conversations.deliveredRowid}, 0)`,
        outStanceExceptions(),
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .limit(limit)
    .all();
  const direct = orm(db)
    .select(eventCols)
    .from(events)
    .leftJoin(conversations, convoJoin())
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.kind, "addressed_message"),
        isNotNull(events.venueId),
        sql`${events}.rowid > ifnull(${conversations.deliveredRowid}, 0)`,
        sql`json_extract(${events.payload}, '$.addressMode') IN ('mention', 'dm')`,
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .all();
  const seen = new Set(rows.map((r) => r.rowid));
  const merged = [...rows, ...direct.filter((r) => !seen.has(r.rowid))].toSorted((a, b) => a.rowid - b.rowid);
  return groupByConversation(db, identityId, messagesOf(merged));
}

export function hasUndelivered(db: Database, identityId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(events)
      .leftJoin(conversations, convoJoin())
      .where(
        and(
          eq(events.identityId, identityId),
          inArray(events.kind, DELIVERABLE_KINDS),
          isNotNull(events.venueId),
          sql`${events}.rowid > ifnull(${conversations.deliveredRowid}, 0)`,
          outStanceExceptions(),
        ),
      )
      .limit(1)
      .get() != null
  );
}

// The ear's side of the same rows: unjudged traffic per conversation, EVERY stance included —
// the ear listens to rooms she has left too (an emergency there should still wake her; her
// stance gates delivery, never the listening).
export function unjudgedConversations(db: Database, identityId: string, limit = 200): PendingConversation[] {
  const rows = orm(db)
    .select(eventCols)
    .from(events)
    .leftJoin(conversations, convoJoin())
    .where(
      and(
        eq(events.identityId, identityId),
        inArray(events.kind, DELIVERABLE_KINDS),
        isNotNull(events.venueId),
        sql`${events}.rowid > ifnull(${conversations.judgedRowid}, 0)`,
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .limit(limit)
    .all();
  return groupByConversation(db, identityId, messagesOf(rows));
}

export function hasUnjudged(db: Database, identityId: string): boolean {
  return (
    orm(db)
      .select({ one: sql`1` })
      .from(events)
      .leftJoin(conversations, convoJoin())
      .where(
        and(
          eq(events.identityId, identityId),
          inArray(events.kind, DELIVERABLE_KINDS),
          isNotNull(events.venueId),
          sql`${events}.rowid > ifnull(${conversations.judgedRowid}, 0)`,
        ),
      )
      .limit(1)
      .get() != null
  );
}

// Judged or punted, these rows are the ear's past now. Monotonic (max), and free to trail
// delivered — the ear bookkeeps addressed traffic after the fact.
export function advanceJudged(db: Database, clock: Clock, identityId: string, key: ConversationKey, judgedRowid: number): void {
  ensureConversation(db, clock, identityId, key.venueId, key.threadRootId);
  orm(db)
    .update(conversations)
    .set({ judgedRowid: sql`max(${conversations.judgedRowid}, ${judgedRowid})` })
    .where(convoEq(identityId, key.venueId, key.threadRootId))
    .run();
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
  const inserted = orm(db)
    .insert(acts)
    .values({
      wakeId,
      actKey,
      identityId,
      kind: act.kind,
      venueId: act.venueId,
      threadRootId: act.threadRootId,
      ts: act.ts,
      text: act.text,
      at: clock(),
    })
    .onConflictDoNothing()
    .returning({ id: acts.id })
    .all().length > 0;
  return { inserted, actKey };
}

// Fills the surface ts once the adapter call returns — and for a TOP-LEVEL post, homes the act
// into the thread that post just rooted (the conversation engage() keys on the message id): her
// own opening message must render in the thread it started, not on the venue surface.
export function setActTs(db: Database, wakeId: string, actKey: string, ts: string, threadRootId?: string | null): void {
  const where = and(eq(acts.wakeId, wakeId), eq(acts.actKey, actKey));
  if (threadRootId !== undefined) {
    orm(db).update(acts).set({ ts, threadRootId }).where(where).run();
  } else {
    orm(db).update(acts).set({ ts }).where(where).run();
  }
}

// Compensating delete: an act records INTENT before the adapter call for retry idempotency; if
// the adapter call itself fails, the intent must not survive to poison the retry (a swallowed
// second attempt would report success for a reaction that never landed) or to render in her
// tail as something she said.
export function deleteAct(db: Database, wakeId: string, actKey: string): void {
  orm(db).delete(acts).where(and(eq(acts.wakeId, wakeId), eq(acts.actKey, actKey))).run();
}

// --- withheld drafts (§5.5), durable --------------------------------------------------------

export function saveDraft(db: Database, clock: Clock, identityId: string, venueId: string, threadRootId: string | null, text: string): void {
  orm(db)
    .insert(drafts)
    .values({ identityId, venueId, threadRootId, text, draftedAt: clock(), consumedAt: null })
    .run();
}

// §5.5: a withheld reply surfaces to the immediately following wake. Reading is a PEEK —
// consumption commits in the wake's finally, scoped to EXACTLY the rows peeked (a wake also
// SAVES drafts mid-turn via the withhold path; a blanket identity-wide stamp would eat its own
// withholds before any wake rendered them — review finding, 2026-08-11) and only for a
// SUCCEEDED turn (a failed wake returns its drafts to the next one instead of eating them).
export function peekDrafts(db: Database, identityId: string): { id: number; venueId: string; threadRootId: string | null; text: string }[] {
  return orm(db)
    .select({ id: drafts.id, venueId: drafts.venueId, threadRootId: drafts.threadRootId, text: drafts.text })
    .from(drafts)
    .where(and(eq(drafts.identityId, identityId), isNull(drafts.consumedAt)))
    .orderBy(asc(drafts.id))
    .all();
}

export function markDraftsConsumed(db: Database, clock: Clock, identityId: string, ids: number[]): void {
  if (ids.length === 0) return;
  orm(db)
    .update(drafts)
    .set({ consumedAt: clock() })
    .where(and(eq(drafts.identityId, identityId), inArray(drafts.id, ids)))
    .run();
}

// The newest deliverable event a conversation has — the bounce card's "delivered through here".
export function maxEventRowid(db: Database, identityId: string, venueId: string, threadRootId: string | null): number {
  const row = orm(db)
    .select({ r: max(sql<number>`${events}.rowid`) })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, venueId),
        inArray(events.kind, DELIVERABLE_KINDS),
        threadRootId
          ? or(eq(events.threadRootId, threadRootId), sql`json_extract(${events.payload}, '$.ts') = ${threadRootId}`)
          : isNull(events.threadRootId),
      ),
    )
    .get();
  return Number(row?.r ?? 0);
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
  mint: (target: RefTarget) => string;
  get: (ref: string) => RefTarget | undefined;
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
    const exact = orm(db)
      .select({ id: events.id, principalId: events.principalId })
      .from(events)
      .where(and(eq(events.identityId, identityId), eq(events.venueId, t.venueId), sql`json_extract(${events.payload}, '$.ts') = ${t.ts}`))
      .orderBy(desc(sql`${events}.rowid`))
      .limit(1)
      .get();
    if (exact) return { eventId: exact.id, principalId: exact.principalId };
  }
  const key = conversationOf(t);
  const row = orm(db)
    .select({ id: events.id, principalId: events.principalId })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, key.venueId),
        inArray(events.kind, DELIVERABLE_KINDS),
        key.threadRootId
          ? or(eq(events.threadRootId, key.threadRootId), sql`json_extract(${events.payload}, '$.ts') = ${key.threadRootId}`)
          : isNull(events.threadRootId),
      ),
    )
    .orderBy(desc(sql`${events}.rowid`))
    .limit(1)
    .get();
  return row ? { eventId: row.id, principalId: row.principalId } : null;
}

// The newest HUMAN speaker in a conversation — the sponsor fallback when a ref's own line is
// machine-authored (a worker report has no principal). Scoped to the conversation the model
// chose; never a batch-level pick.
export function lastSpeakerIn(db: Database, identityId: string, key: ConversationKey): string | null {
  const row = orm(db)
    .select({ principalId: events.principalId })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, key.venueId),
        isNotNull(events.principalId),
        key.threadRootId
          ? or(eq(events.threadRootId, key.threadRootId), sql`json_extract(${events.payload}, '$.ts') = ${key.threadRootId}`)
          : isNull(events.threadRootId),
      ),
    )
    .orderBy(desc(sql`${events}.rowid`))
    .limit(1)
    .get();
  return row?.principalId ?? null;
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
  const theirsEvents = orm(db)
    .select({
      id: events.id,
      principalId: events.principalId,
      text: sql<string | null>`json_extract(${events.payload}, '$.text')`,
      name: sql<string | null>`json_extract(${events.payload}, '$.principalName')`,
      ts: sql<string | null>`json_extract(${events.payload}, '$.ts')`,
    })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, key.venueId),
        sql`${events}.rowid <= ${beforeRowid}`,
        inArray(events.kind, ["addressed_message", "observed_message"]),
        key.threadRootId
          ? or(eq(events.threadRootId, key.threadRootId), sql`json_extract(${events.payload}, '$.ts') = ${key.threadRootId}`)
          : isNull(events.threadRootId),
      ),
    )
    .orderBy(desc(sql`${events}.rowid`))
    .limit(TAIL_LIMIT)
    .all();
  const theirs: TailLine[] = theirsEvents.toReversed().map((r) => ({
    sortTs: r.ts ? Number(r.ts) : 0,
    surfaceTs: r.ts,
    eventId: r.id,
    principalId: r.principalId,
    line: `${who({ principalId: r.principalId, ...(r.name ? { principalName: r.name } : {}) })}: ${(r.text ?? "").slice(0, 300)}`,
  }));
  const hersActs = orm(db)
    .select({ kind: acts.kind, ts: acts.ts, text: acts.text, at: acts.at })
    .from(acts)
    .where(and(eq(acts.identityId, identityId), eq(acts.venueId, key.venueId), sameNullable(acts.threadRootId, key.threadRootId)))
    .orderBy(desc(acts.id))
    .limit(TAIL_LIMIT)
    .all();
  const hers: TailLine[] = hersActs.toReversed().map((a) => ({
    sortTs: a.ts ? Number(a.ts) : Date.parse(a.at) / 1000,
    surfaceTs: null,
    line: a.kind === "posted" ? `${selfLabel}: ${(a.text ?? "").slice(0, 300)}` : `${selfLabel} reacted :${a.text}: to ts=${a.ts}`,
  }));
  return [...theirs, ...hers].toSorted((a, b) => a.sortTs - b.sortTs).slice(-TAIL_LIMIT);
}

export interface RenderOpts {
  // The new messages this render delivers; the renderer formats and ref-tags every line. mark
  // frames how a line reached her ("[to you] ", the ear's "[she was woken for this] ") — the
  // framing differs between readers, the conversation body never does.
  newMessages: InboxMessage[];
  mark?: ((m: InboxMessage) => string) | undefined;
  judgment?: ConversationJudgment | undefined;
  stance?: StanceState | undefined;
  // Tail cutoff: rows at or before this rowid are "already heard". Callers pass the rowid just
  // below their batch so the tail never duplicates the new lines.
  beforeRowid: number;
  // How her own acts read in the tail: the mind sees "you", the ear sees "she". Header lines
  // stay subject-free so both voices read naturally.
  selfLabel?: "you" | "she" | undefined;
  // When present, the renderer MINTS a ref for the conversation and for every message line it
  // emits — the only source of addressable targets for the speaking tools (ladder R4).
  refs?: RefTable | undefined;
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
  const header = headerBits.length > 0 || cref ? `[${address}${headerBits.length > 0 ? `: ${headerBits.join(" | ")}` : ""}]\n` : "";
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
  const tailBlock = tail.length > 0
    ? `earlier in ${where} (already heard — so you can tell who is talking to whom):\n${tail.map((t) => `  ${tag(t.surfaceTs, t.eventId, t.principalId)}${t.line}`).join("\n")}\n`
    : "";
  const newLines = opts.newMessages.map((m) => `${tag(m.ts, m.id, m.principalId)}${mark(m)}${inboxLine(m)}`).join("\n");
  return `${header}${tailBlock}${newLines}`;
}

