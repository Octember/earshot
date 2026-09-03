// Events as inbox rows; delivery watermarks live in conversations.ts.
import type { Database } from "bun:sqlite";
import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { orm } from "./db";
import { events, type Event } from "./schema";

// A line spoken to her (mention or DM), as opposed to thread-follow or observed chatter.
export function isDirectAddress(message: Pick<Event, "payload">): boolean {
  return message.payload.addressMode === "mention" || message.payload.addressMode === "dm";
}

export function messagesAfter(
  db: Database,
  identityId: string,
  afterRowid: number,
  limit = 200,
): Event[] {
  return orm(db)
    .select()
    .from(events)
    .where(
      and(
        eq(events.identityId, identityId),
        gt(events.rowid, afterRowid),
        inArray(events.kind, ["addressed_message", "observed_message", "external_signal"]),
      ),
    )
    .orderBy(asc(events.rowid))
    .limit(limit)
    .all();
}
