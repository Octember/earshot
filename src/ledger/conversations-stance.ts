import type { Database } from "bun:sqlite";
import { eventTs } from "./conversations-util";
import { and, eq, inArray, isNull, sql, gt } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { conversations, events, type Conversation, type Event } from "./schema";
import type { Anchor } from "./tasks-types";

export interface PendingConversation extends Anchor {
  stance: Conversation | null;
  messages: Event[];
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

export function ensureConversation(
  db: Database,
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

export function engage(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): void {
  ensureConversation(db, identityId, venueId, threadRootId);
  orm(db)
    .update(conversations)
    .set({ stance: "engaged", stanceWhy: null, stanceAt: clock() })
    .where(convoEq(identityId, venueId, threadRootId))
    .run();
}

export function stepBack(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
  why: string,
): void {
  ensureConversation(db, identityId, venueId, threadRootId);
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
): Conversation | null {
  return (
    orm(db)
      .select()
      .from(conversations)
      .where(convoEq(identityId, venueId, threadRootId))
      .get() ?? null
  );
}

export function rehomeThreadRoot(
  db: Database,
  identityId: string,
  venueId: string,
  rootTs: string,
): void {
  const root = orm(db)
    .select({ rowid: events.rowid })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, venueId),
        isNull(events.threadRootId),
        eq(eventTs, rootTs),
      ),
    )
    .get();
  if (!root) return;
  db.transaction(() => {
    orm(db).update(events).set({ threadRootId: rootTs }).where(eq(events.rowid, root.rowid)).run();
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
    ensureConversation(db, identityId, venueId, rootTs);

    const otherUndelivered = orm(db)
      .select({ rowid: events.rowid })
      .from(events)
      .where(
        and(
          eq(events.identityId, identityId),
          eq(events.venueId, venueId),
          isNull(events.threadRootId),
          inArray(events.kind, ["addressed_message", "observed_message", "external_signal"]),
          gt(events.rowid, surface.deliveredRowid),
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
