import type { Database } from "bun:sqlite";
import { and, desc, eq, gt, or } from "drizzle-orm";
import { orm } from "./db";
import { acts, events, type Event } from "./schema";
import type { Anchor } from "./tasks-types";
import { eventAddressed, eventTs, sameNullable } from "./conversations-util";

export interface PendingConversation extends Anchor {
  out: string | null;
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

function latestAct(db: Database, identityId: string, venueId: string, root: string | null) {
  return orm(db)
    .select({ kind: acts.kind, text: acts.text, at: acts.at })
    .from(acts)
    .where(
      and(
        eq(acts.identityId, identityId),
        eq(acts.venueId, venueId),
        sameNullable(acts.threadRootId, root),
      ),
    )
    .orderBy(desc(acts.id))
    .limit(1)
    .get();
}

export function hasActedIn(
  db: Database,
  identityId: string,
  venueId: string,
  root: string,
): boolean {
  return latestAct(db, identityId, venueId, root) !== undefined;
}

export function outOf(
  db: Database,
  identityId: string,
  venueId: string,
  root: string | null,
): string | null {
  if (root === null) return null;
  const last = latestAct(db, identityId, venueId, root);
  if (!last || last.kind !== "stepped_back") return null;
  const readdressed = orm(db)
    .select({ rowid: events.rowid })
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        eq(events.venueId, venueId),
        or(eq(events.threadRootId, root), eq(eventTs, root)),
        eventAddressed,
        gt(events.receivedAt, last.at),
      ),
    )
    .limit(1)
    .get();
  return readdressed ? null : last.text;
}

export function recordWakeWhy(db: Database, eventRowid: number, why: string): void {
  orm(db).update(events).set({ wakeWhy: why }).where(eq(events.rowid, eventRowid)).run();
}
