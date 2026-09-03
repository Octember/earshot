import type { Database } from "bun:sqlite";
import type { RawMessage } from "@bevyl-ai/agent-tools";
import { and, asc, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { orm } from "../ledger/db";
import {
  acts,
  attentionItems,
  conversations,
  drafts,
  events,
  executions,
  memoryItems,
  steering,
  tasks,
  timers,
  turns,
} from "../ledger/schema";

export function loadIncident(
  db: Database,
  window: {
    fromIso: string;
    toIso: string;
    venueId?: string;
  },
) {
  const rows = orm(db)
    .select({
      rowid: sql<number>`${events}.rowid`,
      venueId: events.venueId,
      threadRootId: events.threadRootId,
      principalId: events.principalId,
      payload: events.payload,
      receivedAt: events.receivedAt,
    })
    .from(events)
    .where(
      and(
        inArray(events.kind, ["addressed_message", "observed_message"]),
        gte(events.receivedAt, window.fromIso),
        lt(events.receivedAt, window.toIso),
        window.venueId ? eq(events.venueId, window.venueId) : undefined,
      ),
    )
    .orderBy(asc(events.rowid))
    .all();
  return rows.map((row) => {
    const payload = row.payload;
    const files = payload.files;
    const message: RawMessage = {
      venueId: row.venueId,
      venueKind: payload.addressMode === "dm" ? "dm" : "channel",
      principalId: row.principalId,
      isBot: payload.isBot === true,
      text: payload.text,
      ts: payload.ts ?? "",

      threadRootTs: row.threadRootId === payload.ts ? null : row.threadRootId,
      mentionsBotId: payload.addressMode === "mention",
      ...(files ? { files } : {}),
    };
    return { rowid: row.rowid, receivedAt: row.receivedAt, message };
  });
}

export function originalActions(db: Database, fromIso: string, toIso: string) {
  const rows = orm(db)
    .select({ startedAt: turns.startedAt, kind: turns.kind, effects: turns.effects })
    .from(turns)
    .where(
      and(
        gte(turns.startedAt, fromIso),
        lt(turns.startedAt, toIso),
        inArray(turns.kind, ["resident", "attention"]),
      ),
    )
    .orderBy(asc(turns.startedAt))
    .all();
  return rows.map((row) => ({
    startedAt: row.startedAt,
    kind: row.kind,
    effects: row.effects,
  }));
}

export function rewindLedger(db: Database, cutoffRowid: number, fromIso: string) {
  const txn = db.transaction(() => {
    const dbx = orm(db);

    const doomed = dbx
      .select({
        rowid: sql<number>`${events}.rowid`,
        text: sql<string>`coalesce(json_extract(${events.payload}, '$.text'), '')`,
      })
      .from(events)
      .where(gte(events.rowid, cutoffRowid))
      .all();
    for (const doomedRow of doomed)
      dbx.run(
        sql`INSERT INTO events_fts (events_fts, rowid, text) VALUES ('delete', ${doomedRow.rowid}, ${doomedRow.text})`,
      );
    const eventsDeleted = doomed.length;
    dbx.delete(events).where(gte(events.rowid, cutoffRowid)).run();
    const turnsDeleted = dbx
      .delete(turns)
      .where(gte(turns.startedAt, fromIso))
      .returning({ id: turns.id })
      .all().length;
    const itemsDeleted = dbx
      .delete(attentionItems)
      .where(gte(attentionItems.openedAt, fromIso))
      .returning({ id: attentionItems.id })
      .all().length;
    const itemsReopened = dbx
      .update(attentionItems)
      .set({ closedAt: null, closedCause: null })
      .where(gte(attentionItems.closedAt, fromIso))
      .returning({ id: attentionItems.id })
      .all().length;

    dbx
      .update(conversations)
      .set({ stance: "none", stanceWhy: null })
      .where(and(eq(conversations.stance, "out"), gte(conversations.stanceAt, fromIso)))
      .run();
    dbx
      .update(conversations)
      .set({
        deliveredRowid: sql`min(${conversations.deliveredRowid}, ${cutoffRowid - 1})`,
        judgedRowid: sql`min(${conversations.judgedRowid}, ${cutoffRowid - 1})`,
        wakeWhy: null,
      })
      .run();
    dbx.delete(acts).where(gte(acts.at, fromIso)).run();
    dbx.delete(drafts).where(gte(drafts.draftedAt, fromIso)).run();
    const timersDeleted = dbx.delete(timers).returning({ id: timers.id }).all().length;
    dbx.delete(steering).run();
    dbx.delete(executions).run();
    const tasksDeleted = dbx.delete(tasks).returning({ id: tasks.id }).all().length;
    const memoriesInWindow =
      dbx.select({ n: count() }).from(memoryItems).where(gte(memoryItems.createdAt, fromIso)).get()
        ?.n ?? 0;
    return {
      events: eventsDeleted,
      turns: turnsDeleted,
      itemsDeleted,
      itemsReopened,
      tasks: tasksDeleted,
      timers: timersDeleted,
      memoriesInWindow,
    };
  });
  return txn();
}
