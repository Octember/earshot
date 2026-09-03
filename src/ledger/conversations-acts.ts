import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNull, sql, gt } from "drizzle-orm";
import type { Clock } from "./clock";
import { one, orm } from "./db";
import { acts, drafts, events } from "./schema";
import { rootKey } from "./conversations-stance";
import { conversationEventsWhere, sameNullable } from "./conversations-util";

// Record act with adapter call; UNIQUE(wake_id, act_key) for retries.
export function recordAct(
  db: Database,
  clock: Clock,
  identityId: string,
  wakeId: string,
  act: {
    kind: "posted" | "reacted";
    venueId: string;
    threadRootId: string | null;
    ts: string | null;
    text: string;
  },
): { inserted: boolean; actKey: string } {
  const actKey = `${act.kind}:${act.venueId}:${rootKey(act.threadRootId)}:${act.text}:${act.kind === "reacted" ? act.ts : ""}`;
  const result = orm(db)
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
    .get();
  return { inserted: result != null, actKey };
}

// Restart-duplicate: same text in-window → return landed id (check newer events too).
// The newest mention/DM in a conversation she has not posted or reacted in since — the ask she
// owes — and the thread its native session lives on (the message's own ts when top-level).
export function openDirectAsk(
  db: Database,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
): { threadTs: string } | null {
  const lastActAt = orm(db)
    .select({ at: sql<string>`coalesce(max(${acts.at}), '')` })
    .from(acts)
    .where(
      and(
        eq(acts.identityId, identityId),
        eq(acts.venueId, venueId),
        sameNullable(acts.threadRootId, threadRootId),
      ),
    );
  const row = orm(db)
    .select({
      ts: sql<string | null>`json_extract(${events.payload}, '$.ts')`,
      threadRootId: events.threadRootId,
    })
    .from(events)
    .where(
      conversationEventsWhere(
        identityId,
        { venueId, threadRootId },
        and(
          eq(events.kind, "addressed_message"),
          inArray(sql`json_extract(${events.payload}, '$.addressMode')`, ["mention", "dm"]),
          gt(events.receivedAt, lastActAt),
        ),
      ),
    )
    .orderBy(desc(events.rowid))
    .limit(1)
    .get();
  if (!row?.ts) return null;
  return { threadTs: row.threadRootId ?? row.ts };
}

export function recentIdenticalPost(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
  text: string,
  excludeWakeId: string,
  windowMs: number,
  opts: { unlessNewerEventArrived: boolean },
): string | null {
  const cutoff = new Date(new Date(clock()).getTime() - windowMs).toISOString();
  const newerEvent = opts.unlessNewerEventArrived
    ? threadRootId
      ? `AND NOT EXISTS (SELECT 1 FROM events ev
           WHERE ev.identity_id = acts.identity_id AND ev.venue_id = acts.venue_id
             AND (ev.thread_root_id = acts.thread_root_id OR json_extract(ev.payload, '$.ts') = acts.thread_root_id)
             AND ev.kind IN ('addressed_message','observed_message','external_signal')
             AND ev.received_at > acts.at)`
      : `AND NOT EXISTS (SELECT 1 FROM events ev
           WHERE ev.identity_id = acts.identity_id AND ev.venue_id = acts.venue_id
             AND ev.thread_root_id IS NULL
             AND ev.kind IN ('addressed_message','observed_message','external_signal')
             AND ev.received_at > acts.at)`
    : "";
  const row = threadRootId
    ? one<{ ts: string }>(
        db,
        `SELECT ts FROM acts
          WHERE identity_id = ? AND kind = 'posted' AND venue_id = ? AND thread_root_id = ?
            AND text = ? AND wake_id != ? AND ts IS NOT NULL AND at >= ? ${newerEvent}
          ORDER BY id DESC LIMIT 1`,
        identityId,
        venueId,
        threadRootId,
        text,
        excludeWakeId,
        cutoff,
      )
    : one<{ ts: string }>(
        db,
        `SELECT ts FROM acts
          WHERE identity_id = ? AND kind = 'posted' AND venue_id = ?
            AND (thread_root_id IS NULL OR thread_root_id = ts)
            AND text = ? AND wake_id != ? AND ts IS NOT NULL AND at >= ? ${newerEvent}
          ORDER BY id DESC LIMIT 1`,
        identityId,
        venueId,
        text,
        excludeWakeId,
        cutoff,
      );
  return row?.ts ?? null;
}

// Backfill ts; top-level posts home into the thread they rooted.
export function setActTs(
  db: Database,
  wakeId: string,
  actKey: string,
  ts: string,
  threadRootId?: string | null,
): void {
  const where = and(eq(acts.wakeId, wakeId), eq(acts.actKey, actKey));
  if (threadRootId !== undefined) {
    orm(db).update(acts).set({ ts, threadRootId }).where(where).run();
  } else {
    orm(db).update(acts).set({ ts }).where(where).run();
  }
}

// Delete intent if adapter call fails (else retry/tail lie).
export function deleteAct(db: Database, wakeId: string, actKey: string): void {
  orm(db)
    .delete(acts)
    .where(and(eq(acts.wakeId, wakeId), eq(acts.actKey, actKey)))
    .run();
}

export function saveDraft(
  db: Database,
  clock: Clock,
  identityId: string,
  venueId: string,
  threadRootId: string | null,
  text: string,
): void {
  orm(db)
    .insert(drafts)
    .values({ identityId, venueId, threadRootId, text, draftedAt: clock(), consumedAt: null })
    .run();
}

// §5.5: peek withheld drafts; consume only peeked ids after a succeeded wake (not mid-turn saves).
export function peekDrafts(
  db: Database,
  identityId: string,
): { id: number; venueId: string; threadRootId: string | null; text: string }[] {
  return orm(db)
    .select({
      id: drafts.id,
      venueId: drafts.venueId,
      threadRootId: drafts.threadRootId,
      text: drafts.text,
    })
    .from(drafts)
    .where(and(eq(drafts.identityId, identityId), isNull(drafts.consumedAt)))
    .orderBy(asc(drafts.id))
    .all();
}

export function markDraftsConsumed(
  db: Database,
  clock: Clock,
  identityId: string,
  ids: number[],
): void {
  if (ids.length === 0) return;
  orm(db)
    .update(drafts)
    .set({ consumedAt: clock() })
    .where(and(eq(drafts.identityId, identityId), inArray(drafts.id, ids)))
    .run();
}
