import type { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { stances, type Stance, type Event } from "./schema";
import type { Anchor } from "./tasks-types";

export interface PendingConversation extends Anchor {
  stance: Stance | null;
  messages: Event[];
}

export function conversationOfEvent(message: Event): Anchor {
  return { venueId: message.venueId, threadRootId: message.threadRootId ?? message.payload.ts };
}

export function rootKey(threadRootId: string | null): string {
  return threadRootId ?? "";
}

export function convoKey(venueId: string, threadRootId: string | null): string {
  return `${venueId}|${rootKey(threadRootId)}`;
}

function stanceEq(identityId: string, venueId: string, root: string) {
  return and(
    eq(stances.identityId, identityId),
    eq(stances.venueId, venueId),
    eq(stances.root, root),
  );
}

function upsert(
  db: Database,
  identityId: string,
  venueId: string,
  root: string,
  set: Partial<Stance>,
  at: string,
): void {
  orm(db)
    .insert(stances)
    .values({ identityId, venueId, root, stance: "none", why: null, at, wakeWhy: null, ...set })
    .onConflictDoUpdate({ target: [stances.identityId, stances.venueId, stances.root], set })
    .run();
}

export function engage(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  root: string,
): void {
  upsert(db, identityId, venueId, root, { stance: "engaged", why: null, at: clock() }, clock());
}

export function stepBack(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  root: string | null,
  why: string,
): void {
  if (root === null) return;
  upsert(db, identityId, venueId, root, { stance: "out", why, at: clock() }, clock());
}

export function recordWakeWhy(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  root: string | null,
  why: string,
): void {
  if (root === null) return;
  upsert(db, identityId, venueId, root, { wakeWhy: why }, clock());
}

export function clearWakeWhy(
  db: Database,
  identityId: string,
  venueId: string,
  root: string,
): void {
  orm(db)
    .update(stances)
    .set({ wakeWhy: null })
    .where(stanceEq(identityId, venueId, root))
    .run();
}

export function stanceOf(
  db: Database,
  identityId: string,
  venueId: string,
  root: string | null,
): Stance | null {
  if (root === null) return null;
  return (
    orm(db)
      .select()
      .from(stances)
      .where(stanceEq(identityId, venueId, root))
      .get() ?? null
  );
}
