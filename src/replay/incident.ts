// Replay harness (dev tool, not part of the daemon): carve a real incident out of a ledger
// snapshot and rewind the snapshot to the moment before it, so the service can relive the same
// inbound traffic — real model judgment, captured room (run.ts). Rewind is destructive: always
// run it on a COPY of the ledger, never the live file (the CLI copies before opening).
import type { Database } from "bun:sqlite";
import type { RawMessage, MessageFile } from "@bevyl-ai/agent-tools";
import { asString, isRecord, parseJson } from "../guard";
import { many, one } from "../ledger/db";

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
  return files.length ? files : undefined;
}

export interface IncidentEvent {
  rowid: number;
  receivedAt: string;
  message: RawMessage;
}

export interface IncidentWindow {
  fromIso: string;
  toIso: string;
  venueId?: string; // omit to replay every venue active in the window
}

interface EventRow {
  rowid: number;
  venue_id: string | null;
  thread_root_id: string | null;
  principal_id: string | null;
  payload: string;
  received_at: string;
}

// Surface messages in the window, reconstructed into the RawMessage the adapter originally
// delivered. addressMode (the router's output, stored in the payload) round-trips to the inbound
// flags: a mention is the only source of mentionsBotId, and dm is the only non-channel venueKind
// the router ever records. external_signal rows are excluded — those are the system's own
// productions (worker outcomes, timers) and the replay's service re-derives them itself.
export function loadIncident(db: Database, w: IncidentWindow): IncidentEvent[] {
  const rows = many<EventRow>(
    db,
    `SELECT rowid, venue_id, thread_root_id, principal_id, payload, received_at FROM events
       WHERE kind IN ('addressed_message','observed_message') AND received_at >= ? AND received_at < ?
       ${w.venueId ? "AND venue_id = ?" : ""} ORDER BY rowid`,
    ...(w.venueId ? [w.fromIso, w.toIso, w.venueId] : [w.fromIso, w.toIso]),
  );
  return rows.map((r) => {
    const parsed = parseJson(r.payload);
    const p = isRecord(parsed) ? parsed : {};
    const ts = asString(p.ts);
    const files = messageFiles(p.files);
    return {
      rowid: r.rowid,
      receivedAt: r.received_at,
      message: {
        venueId: r.venue_id ?? "",
        venueKind: p.addressMode === "dm" ? "dm" : "channel",
        principalId: r.principal_id,
        isBot: p.isBot === true,
        text: asString(p.text),
        ts,
        // A root the router re-homed into its own thread (thread_root_id = its own ts) was
        // delivered top-level — reconstruct it that way so the replay's own router re-homes it.
        threadRootTs: r.thread_root_id === ts ? null : r.thread_root_id,
        mentionsBotId: p.addressMode === "mention",
        ...(files ? { files } : {}),
      },
    };
  });
}

export interface OriginalTurn {
  startedAt: string;
  kind: string;
  effects: unknown[];
}

// What she actually did in the window — read BEFORE rewindLedger, which deletes these rows.
export function originalActions(db: Database, fromIso: string, toIso: string): OriginalTurn[] {
  const rows = many<{ started_at: string; kind: string; effects: string }>(
    db,
    "SELECT started_at, kind, effects FROM turns WHERE started_at >= ? AND started_at < ? AND kind IN ('resident','attention') ORDER BY started_at",
    fromIso,
    toIso,
  );
  return rows.map((r) => {
    const effects = parseJson(r.effects);
    return { startedAt: r.started_at, kind: r.kind, effects: Array.isArray(effects) ? effects : [] };
  });
}

export interface RewindReport {
  events: number;
  turns: number;
  itemsDeleted: number;
  itemsReopened: number;
  tasks: number;
  timers: number;
  memoriesInWindow: number; // NOT rewound (no edit history) — reported so the caveat is visible
}

// Point-in-time rewind: everything the service wrote at or after the window start is unwound so
// the replay's own passes rebuild it. Participation stepped-back during the window is un-stepped
// (it had not happened yet); the rows themselves stay — participation without traffic is inert.
// Tasks, executions, steering, and timers are cleared outright: a replay relives conversations,
// and a snapshot's scheduler state firing mid-replay is noise, not fidelity. Memory edits cannot
// be rewound (items carry no edit history); the count is reported instead.
export function rewindLedger(db: Database, cutoffRowid: number, fromIso: string): RewindReport {
  const tx = db.transaction(() => {
    // events_fts is contentless (content='') with an insert-only trigger, so doomed docs must be
    // removed explicitly — an fts5 'delete' needs the original text back.
    const doomed = many<{ rowid: number; text: string }>(
      db,
      "SELECT rowid, coalesce(json_extract(payload,'$.text'),'') AS text FROM events WHERE rowid >= ?",
      cutoffRowid,
    );
    for (const d of doomed) db.query("INSERT INTO events_fts (events_fts, rowid, text) VALUES ('delete', ?, ?)").run(d.rowid, d.text);
    const events = db.query("DELETE FROM events WHERE rowid >= ?").run(cutoffRowid).changes;
    const turns = db.query("DELETE FROM turns WHERE started_at >= ?").run(fromIso).changes;
    const itemsDeleted = db.query("DELETE FROM attention_items WHERE opened_at >= ?").run(fromIso).changes;
    const itemsReopened = db.query("UPDATE attention_items SET closed_at = NULL, closed_cause = NULL WHERE closed_at >= ?").run(fromIso).changes;
    // One room, one row: rewind each conversation's watermarks and judgment; a step-out taken
    // during the window had not happened yet. Her acts and withheld drafts in the window are
    // the service's own productions — the replay re-derives them.
    db.query("UPDATE conversations SET stance = 'none', stance_why = NULL WHERE stance = 'out' AND stance_at >= ?").run(fromIso);
    db.query(
      "UPDATE conversations SET delivered_rowid = min(delivered_rowid, ?), judged_rowid = min(judged_rowid, ?), holds = 0, hold_whys = '[]', wake_why = NULL",
    ).run(cutoffRowid - 1, cutoffRowid - 1);
    db.query("DELETE FROM acts WHERE at >= ?").run(fromIso);
    db.query("DELETE FROM drafts WHERE drafted_at >= ?").run(fromIso);
    const timers = db.query("DELETE FROM timers").run().changes;
    db.query("DELETE FROM steering").run();
    db.query("DELETE FROM executions").run();
    const tasks = db.query("DELETE FROM tasks").run().changes;
    const memoriesInWindow = one<{ n: number }>(db, "SELECT count(*) AS n FROM memory_items WHERE created_at >= ?", fromIso)?.n ?? 0;
    return { events, turns, itemsDeleted, itemsReopened, tasks, timers, memoriesInWindow };
  });
  return tx();
}
