import type { Database } from "bun:sqlite";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { conversations, events, type Stance } from "./schema";
import type { InboxMessage } from "./inbox";

export type { Stance };

export interface ConversationKey {
  venueId: string;
  threadRootId: string | null;
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

export function convoEq(identityId: string, venueId: string, threadRootId: string | null) {
  return and(
    eq(conversations.identityId, identityId),
    eq(conversations.venueId, venueId),
    eq(conversations.threadRootId, rootKey(threadRootId)),
  );
}

function asStance(value: string): Stance {
  return value === "engaged" || value === "out" ? value : "none";
}

export function ensureConversation(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): void {
  orm(db)
    .insert(conversations)
    .values({
      identityId,
      venueId,
      threadRootId: rootKey(threadRootId),
      firstAt: clock(),
      deliveredRowid: 0,
      judgedRowid: 0,
      wakeWhy: null,
      stance: "none",
      stanceWhy: null,
      stanceAt: null,
    })
    .onConflictDoNothing()
    .run();
}

// §5.1: mention/addressed inbound or this identity's outbound post engages (clears step-back).
export function engage(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  orm(db)
    .update(conversations)
    .set({ stance: "engaged", stanceWhy: null, stanceAt: clock() })
    .where(convoEq(identityId, venueId, threadRootId))
    .run();
}

// Step out: replies stay undelivered until re-engaged.
export function stepBack(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
  why: string,
): void {
  ensureConversation(db, clock, identityId, venueId, threadRootId);
  orm(db)
    .update(conversations)
    .set({ stance: "out", stanceWhy: why, stanceAt: clock() })
    .where(convoEq(identityId, venueId, threadRootId))
    .run();
}

export function stanceOf(
  db: Database,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): StanceState {
  const row = orm(db)
    .select({
      stance: conversations.stance,
      stanceWhy: conversations.stanceWhy,
      stanceAt: conversations.stanceAt,
    })
    .from(conversations)
    .where(convoEq(identityId, venueId, threadRootId))
    .get();
  return row
    ? { stance: asStance(row.stance), why: row.stanceWhy, at: row.stanceAt }
    : { stance: "none", why: null, at: null };
}

// Re-home root into thread at first reply; preserve deliveredness.
export function rehomeThreadRoot(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  rootTs: string,
): void {
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
    orm(db)
      .update(events)
      .set({ threadRootId: rootTs })
      .where(sql`${events}.rowid = ${root.rowid}`)
      .run();
    const surface = orm(db)
      .select({
        deliveredRowid: conversations.deliveredRowid,
        judgedRowid: conversations.judgedRowid,
        wakeWhy: conversations.wakeWhy,
      })
      .from(conversations)
      .where(convoEq(identityId, venueId, ""))
      .get();
    if (!surface) return;
    ensureConversation(db, clock, identityId, venueId, rootTs);
    // Move the surface's wake why with the root only if it was the sole undelivered msg.
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
    if (surface.deliveredRowid < root.rowid && !otherUndelivered && surface.wakeWhy) {
      orm(db)
        .update(conversations)
        .set({ wakeWhy: surface.wakeWhy })
        .where(convoEq(identityId, venueId, rootTs))
        .run();
      orm(db)
        .update(conversations)
        .set({ wakeWhy: null })
        .where(convoEq(identityId, venueId, ""))
        .run();
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
