import type { Database } from "bun:sqlite";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { Clock } from "./clock";
import { orm } from "./db";
import { events, type Event } from "./schema";
import {
  clearWakeWhy,
  conversationOfEvent,
  convoKey,
  stanceOf,
  type PendingConversation,
} from "./conversations-stance";
import { DELIVERABLE_KINDS } from "./conversations-util";
import { isDirectAddress } from "./inbox";

type Pass = "deliveredAt" | "judgedAt";

function pendingRows(db: Database, identityId: string, pass: Pass, limit: number): Event[] {
  return orm(db)
    .select()
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        isNull(events[pass]),
        inArray(events.kind, DELIVERABLE_KINDS),
      ),
    )
    .orderBy(asc(events.rowid))
    .limit(limit)
    .all();
}

function stamp(db: Database, clock: Clock, pass: Pass, rows: Event[]): void {
  if (rows.length === 0) return;
  orm(db)
    .update(events)
    .set({ [pass]: clock() })
    .where(
      inArray(
        events.rowid,
        rows.map((row) => row.rowid),
      ),
    )
    .run();
}

function pendingConversationsFor(
  db: Database,
  clock: Clock,
  identityId: string,
  pass: Pass,
): PendingConversation[] {
  const grouped = new Map<string, PendingConversation>();
  for (const message of pendingRows(db, identityId, pass, 200)) {
    const home = conversationOfEvent(message);
    const key = convoKey(home.venueId, home.threadRootId);
    let group = grouped.get(key);
    if (!group) {
      group = {
        ...home,
        stance: stanceOf(db, identityId, home.venueId, home.threadRootId),
        messages: [],
      };
      grouped.set(key, group);
    }
    group.messages.push(message);
  }
  const heard: PendingConversation[] = [];
  for (const group of grouped.values()) {
    const skip =
      group.stance?.stance === "out" &&
      !group.stance.wakeWhy &&
      !group.messages.some((message) => isDirectAddress(message));
    if (skip) stamp(db, clock, pass, group.messages);
    else heard.push(group);
  }
  return heard;
}

export function pendingConversations(db: Database, clock: Clock, identityId: string) {
  return pendingConversationsFor(db, clock, identityId, "deliveredAt");
}

export function unjudgedConversations(db: Database, clock: Clock, identityId: string) {
  return pendingConversationsFor(db, clock, identityId, "judgedAt");
}

export function hasUndelivered(db: Database, identityId: string): boolean {
  return pendingRows(db, identityId, "deliveredAt", 1).length > 0;
}

export function hasUnjudged(db: Database, identityId: string): boolean {
  return pendingRows(db, identityId, "judgedAt", 1).length > 0;
}

export function markDelivered(
  db: Database,
  clock: Clock,
  identityId: string,
  convos: PendingConversation[],
): void {
  for (const convo of convos) {
    stamp(db, clock, "deliveredAt", convo.messages);
    if (convo.threadRootId) clearWakeWhy(db, identityId, convo.venueId, convo.threadRootId);
  }
}

export function markJudged(db: Database, clock: Clock, convos: PendingConversation[]): void {
  for (const convo of convos) stamp(db, clock, "judgedAt", convo.messages);
}
