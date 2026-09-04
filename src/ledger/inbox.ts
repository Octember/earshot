import type { Database } from "bun:sqlite";
import { and, asc, eq, gt } from "drizzle-orm";
import { orm } from "./db";
import { events, type Event } from "./schema";

export function isDirectAddress(message: Pick<Event, "addressMode">): boolean {
  return message.addressMode === "mention" || message.addressMode === "dm";
}

export function messagesAfter(db: Database, identityId: string, afterRowid: number): Event[] {
  return orm(db)
    .select()
    .from(events)
    .where(and(eq(events.identityId, identityId), gt(events.rowid, afterRowid)))
    .orderBy(asc(events.rowid))
    .limit(200)
    .all();
}
