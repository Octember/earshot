// Replay harness (dev tool, not part of the daemon): carve a real incident out of a ledger
// snapshot and rewind the snapshot to the moment before it, so the service can relive the same
// inbound traffic — real model judgment, captured room (run.ts). Rewind is destructive: always
// run it on a COPY of the ledger, never the live file (the CLI copies before opening).
import type { Database } from "bun:sqlite";
import type { RawMessage, MessageFile } from "@bevyl-ai/agent-tools";
import { and, asc, count, eq, gte, inArray, lt, sql } from "drizzle-orm";
import { asString, isRecord } from "../guard";
import { orm } from "../ledger/db";
import { acts, attentionItems, conversations, drafts, events, executions, memoryItems, steering, tasks, timers, turns } from "../ledger/schema";

export function messageFiles(v: unknown): MessageFile[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const files: MessageFile[] = [];
  for (const item of v) {
    if (
      !isRecord(item) ||
      typeof item.id !== "string" ||
      typeof item.name !== "string" ||
      typeof item.mimetype !== "string" ||
      typeof item.urlPrivate !== "string" ||
      typeof item.size !== "number"
    ) {
      continue;
    }
    files.push({
      id: item.id,
      name: item.name,
      mimetype: item.mimetype,
      urlPrivate: item.urlPrivate,
      size: item.size,
    });
  }
  return files.length > 0 ? files : undefined;
}

export interface IncidentWindow {
  fromIso: string;
  toIso: string;
  venueId?: string; // omit to replay every venue active in the window
}

// Surface messages in the window, reconstructed into the RawMessage the adapter originally
// delivered. addressMode (the router's output, stored in the payload) round-trips to the inbound
// flags: a mention is the only source of mentionsBotId, and dm is the only non-channel venueKind
// the router ever records. external_signal rows are excluded — those are the system's own
// productions (worker outcomes, timers) and the replay's service re-derives them itself.
export function loadIncident(db: Database, w: IncidentWindow) {
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
        gte(events.receivedAt, w.fromIso),
        lt(events.receivedAt, w.toIso),
        w.venueId ? eq(events.venueId, w.venueId) : undefined,
      ),
    )
    .orderBy(asc(sql`${events}.rowid`))
    .all();
  return rows.map((r) => {
    const p = isRecord(r.payload) ? r.payload : {};
    const ts = asString(p.ts);
    const files = messageFiles(p.files);
    const message: RawMessage = {
      venueId: r.venueId ?? "",
      venueKind: p.addressMode === "dm" ? "dm" : "channel",
      principalId: r.principalId,
      isBot: p.isBot === true,
      text: asString(p.text),
      ts,
      // A root the router re-homed into its own thread (thread_root_id = its own ts) was
      // delivered top-level — reconstruct it that way so the replay's own router re-homes it.
      threadRootTs: r.threadRootId === ts ? null : r.threadRootId,
      mentionsBotId: p.addressMode === "mention",
      ...(files ? { files } : {}),
    };
    return { rowid: r.rowid, receivedAt: r.receivedAt, message };
  });
}

export type IncidentEvent = ReturnType<typeof loadIncident>[number];

// Outbound acts in the window — read BEFORE rewindLedger, which deletes these rows.
export function originalActions(db: Database, fromIso: string, toIso: string) {
  const rows = orm(db)
    .select({ startedAt: turns.startedAt, kind: turns.kind, effects: turns.effects })
    .from(turns)
    .where(and(gte(turns.startedAt, fromIso), lt(turns.startedAt, toIso), inArray(turns.kind, ["resident", "attention"])))
    .orderBy(asc(turns.startedAt))
    .all();
  return rows.map((r) => ({ startedAt: r.startedAt, kind: r.kind, effects: Array.isArray(r.effects) ? r.effects : [] }));
}

// Point-in-time rewind: everything the service wrote at or after the window start is unwound so
// the replay's own passes rebuild it. Participation stepped-back during the window is un-stepped
// (it had not happened yet); the rows themselves stay — participation without traffic is inert.
// Tasks, executions, steering, and timers are cleared outright: a replay relives conversations,
// and a snapshot's scheduler state firing mid-replay is noise, not fidelity. Memory edits cannot
// be rewound (items carry no edit history); the count is reported instead.
export function rewindLedger(db: Database, cutoffRowid: number, fromIso: string) {
  const tx = db.transaction(() => {
    const dbx = orm(db);
    // events_fts is contentless (content='') with an insert-only trigger, so doomed docs must be
    // removed explicitly — an fts5 'delete' needs the original text back.
    const doomed = dbx
      .select({
        rowid: sql<number>`${events}.rowid`,
        text: sql<string>`coalesce(json_extract(${events.payload}, '$.text'), '')`,
      })
      .from(events)
      .where(sql`${events}.rowid >= ${cutoffRowid}`)
      .all();
    for (const d of doomed) dbx.run(sql`INSERT INTO events_fts (events_fts, rowid, text) VALUES ('delete', ${d.rowid}, ${d.text})`);
    const eventsDeleted = doomed.length;
    dbx.delete(events).where(sql`${events}.rowid >= ${cutoffRowid}`).run();
    const turnsDeleted = dbx.delete(turns).where(gte(turns.startedAt, fromIso)).returning({ id: turns.id }).all().length;
    const itemsDeleted = dbx.delete(attentionItems).where(gte(attentionItems.openedAt, fromIso)).returning({ id: attentionItems.id }).all().length;
    const itemsReopened = dbx
      .update(attentionItems)
      .set({ closedAt: null, closedCause: null })
      .where(gte(attentionItems.closedAt, fromIso))
      .returning({ id: attentionItems.id })
      .all().length;
    // One room, one row: rewind each conversation's watermarks and judgment; a step-out taken
    // during the window had not happened yet. Her acts and withheld drafts in the window are
    // the service's own productions — the replay re-derives them.
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
        holds: 0,
        holdWhys: [],
        wakeWhy: null,
      })
      .run();
    dbx.delete(acts).where(gte(acts.at, fromIso)).run();
    dbx.delete(drafts).where(gte(drafts.draftedAt, fromIso)).run();
    const timersDeleted = dbx.delete(timers).returning({ id: timers.id }).all().length;
    dbx.delete(steering).run();
    dbx.delete(executions).run();
    const tasksDeleted = dbx.delete(tasks).returning({ id: tasks.id }).all().length;
    const memoriesInWindow = dbx.select({ n: count() }).from(memoryItems).where(gte(memoryItems.createdAt, fromIso)).get()?.n ?? 0;
    return { events: eventsDeleted, turns: turnsDeleted, itemsDeleted, itemsReopened, tasks: tasksDeleted, timers: timersDeleted, memoriesInWindow };
  });
  return tx();
}
