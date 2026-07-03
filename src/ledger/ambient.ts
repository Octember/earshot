// SPEC §9.1, §9.2 — ambient behavior's ledger-side mechanics: the observed-message buffer (§17.1's
// "buffer_for_ambient" is just a query over events already persisted by the router — no separate
// buffer table) and the per-venue daily post cap.
import type { Database } from "bun:sqlite";
import type { Clock } from "./clock";
import { writeAudit } from "./audit";

export interface ObservedMessage {
  id: string;
  venueId: string;
  threadRootId: string | null;
  principalId: string | null;
  text: string;
  receivedAt: string;
}

interface Row {
  id: string;
  venue_id: string;
  thread_root_id: string | null;
  principal_id: string | null;
  payload: string;
  received_at: string;
}

// SPEC §9.1: "the buffer since the last tick" — every observed_message for this identity received
// after `sinceIso`.
export function bufferedObservedMessages(db: Database, identityId: string, sinceIso: string): ObservedMessage[] {
  const rows = db
    .query(
      `SELECT id, venue_id, thread_root_id, principal_id, payload, received_at FROM events
       WHERE identity_id = ? AND kind = 'observed_message' AND received_at > ? ORDER BY received_at`,
    )
    .all(identityId, sinceIso) as Row[];
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    threadRootId: r.thread_root_id,
    principalId: r.principal_id,
    text: (JSON.parse(r.payload) as { text?: string }).text ?? "",
    receivedAt: r.received_at,
  }));
}

// Distillation reads BOTH kinds: conversations addressed to the agent are the highest-signal
// source of durable facts, not just overheard chatter. (Ambient keeps using observed-only above.)
export function distillableMessages(db: Database, identityId: string, sinceIso: string): ObservedMessage[] {
  const rows = db
    .query(
      `SELECT id, venue_id, thread_root_id, principal_id, payload, received_at FROM events
       WHERE identity_id = ? AND kind IN ('observed_message', 'addressed_message') AND received_at > ? ORDER BY received_at`,
    )
    .all(identityId, sinceIso) as Row[];
  return rows.map((r) => ({
    id: r.id,
    venueId: r.venue_id,
    threadRootId: r.thread_root_id,
    principalId: r.principal_id,
    text: (JSON.parse(r.payload) as { text?: string }).text ?? "",
    receivedAt: r.received_at,
  }));
}

// A calendar day never exceeds 24h across any timezone offset (max ~14h skew), so 2 days back
// always covers "today" in the configured timezone without SQL-side timezone arithmetic — same
// approach as policy/budget.ts's monthly bucketing.
const SCAN_WINDOW_MS = 2 * 24 * 60 * 60 * 1000;

function dayKey(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(
    new Date(iso),
  );
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

// SPEC §9.2: "posts beyond the cap are dropped with an audit record" — every attempt (posted or
// dropped) is recorded; only successful posts count toward the cap.
export function recordAmbientPost(db: Database, clock: Clock, identityId: string, venueId: string, posted: boolean): void {
  writeAudit(db, clock(), identityId, "ambient_posted", { venueId, posted });
}

export function ambientPostsToday(db: Database, clock: Clock, identityId: string, venueId: string, timezone: string): number {
  const now = clock();
  const key = dayKey(now, timezone);
  const since = new Date(new Date(now).getTime() - SCAN_WINDOW_MS).toISOString();
  const rows = db
    .query("SELECT at, payload FROM audit WHERE kind = 'ambient_posted' AND identity_id = ? AND at >= ?")
    .all(identityId, since) as { at: string; payload: string }[];
  return rows.filter((r) => {
    const payload = JSON.parse(r.payload) as { venueId: string; posted: boolean };
    return payload.venueId === venueId && payload.posted && dayKey(r.at, timezone) === key;
  }).length;
}
