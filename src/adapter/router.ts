// SPEC §17.1, §5.1, §10.5, §7.2 — Event Ingest and Routing. Turns chat into (or away from) work:
// dedup, venue→identity binding, addressed-vs-observed classification, bot/self loop prevention.
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { writeAudit } from "../ledger/audit";
import { isThreadParticipant, recordThreadParticipation } from "../ledger/threads";
import type { Policy } from "../policy/schema";
import type { RawMessage, VenueKind } from "./types";

export type EventKind = "addressed_message" | "observed_message";

export interface Event {
  id: string;
  identityId: string;
  kind: EventKind;
  venueId: string;
  threadRootId: string | null;
  principalId: string | null;
  text: string;
  ts: string;
  receivedAt: string;
}

export type RouteResult =
  | { kind: "ignored_self" }
  | { kind: "unbound_venue"; venueId: string }
  | { kind: "duplicate" }
  | { kind: "addressed"; event: Event }
  | { kind: "observed"; event: Event };

export interface RouterOpts {
  botPrincipalId: string;
  policy: Policy;
  newEventId: () => string;
  // §7.2: unbound-venue traffic is dropped and logged — not written to the ledger (there's no
  // identity to scope it to; events/audit are identity-scoped tables). This is the "log" in
  // "log_unbound", a structured-logs concern (SPEC §15/§3.2 Observability Layer), not a DB write.
  onUnboundVenue?: (venueId: string) => void;
}

function bindVenue(policy: Policy, venueId: string, venueKind: VenueKind): string | null {
  // Explicit binding wins (SPEC §7.2: each venue → exactly one identity).
  for (const identity of policy.identities) {
    if (identity.venueIds.includes(venueId)) return identity.id;
  }
  if (venueKind === "dm" && policy.defaultDmIdentity) return policy.defaultDmIdentity;
  // Wildcard catch-all: an identity whose venue_ids include "*" serves any venue not explicitly
  // bound above — the single-operator "one identity for everything" shortcut (§7.2 still holds:
  // each venue maps to exactly one identity, the catch-all one). Explicit bindings still take
  // precedence, so you can pin specific venues to other identities and let "*" mop up the rest.
  for (const identity of policy.identities) {
    if (identity.venueIds.includes("*")) return identity.id;
  }
  return null;
}

function isAddressed(db: Database, msg: RawMessage, policy: Policy): boolean {
  // §10.5: an untrusted bot's message is never addressed, even a DM, even a mention — this veto
  // outranks every rule below it (loop prevention over convenience).
  if (msg.isBot && !policy.trustedBotPrincipals.includes(msg.principalId ?? "")) return false;
  if (msg.venueKind === "dm") return true; // §5.1: every DM message is addressed
  if (msg.mentionsBotId) return true;
  if (msg.threadRootTs && isThreadParticipant(db, msg.venueId, msg.threadRootTs)) return true;
  return false;
}

export function routeMessage(db: Database, clock: Clock, msg: RawMessage, opts: RouterOpts): RouteResult {
  // §10.5: the agent MUST ignore its own messages entirely — never persisted, never audited.
  if (msg.isBot && msg.principalId === opts.botPrincipalId) return { kind: "ignored_self" };

  const identityId = bindVenue(opts.policy, msg.venueId, msg.venueKind);
  if (!identityId) {
    opts.onUnboundVenue?.(msg.venueId);
    return { kind: "unbound_venue", venueId: msg.venueId };
  }

  const addressed = isAddressed(db, msg, opts.policy);
  const eventKind: EventKind = addressed ? "addressed_message" : "observed_message";
  const dedupKey = `slack:${msg.venueId}:${msg.deliveryId ?? msg.ts}`;
  const eventId = opts.newEventId();
  const now = clock();

  try {
    db.query(
      `INSERT INTO events (id, dedup_key, kind, identity_id, venue_id, thread_root_id, principal_id, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(eventId, dedupKey, eventKind, identityId, msg.venueId, msg.threadRootTs, msg.principalId, JSON.stringify({ text: msg.text, ts: msg.ts, isBot: msg.isBot }), now);
  } catch {
    return { kind: "duplicate" };
  }

  writeAudit(db, now, identityId, "event_received", { eventId, kind: eventKind });
  // §5.1: an addressed message establishes (or continues) thread participation — a thread reply
  // roots on its parent's ts; a fresh top-level addressed message roots on its OWN ts, so later
  // replies threaded on it are recognized without needing a fresh mention.
  if (addressed) recordThreadParticipation(db, clock, identityId, msg.venueId, msg.threadRootTs ?? msg.ts);

  const event: Event = {
    id: eventId,
    identityId,
    kind: eventKind,
    venueId: msg.venueId,
    threadRootId: msg.threadRootTs,
    principalId: msg.principalId,
    text: msg.text,
    ts: msg.ts,
    receivedAt: now,
  };
  return addressed ? { kind: "addressed", event } : { kind: "observed", event };
}
