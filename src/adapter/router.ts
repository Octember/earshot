// Event ingest: dedup, venue→identity, addressed-vs-observed, self-loop prevention.
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { writeAudit } from "../ledger/audit";
import { engage, stanceOf, rehomeThreadRoot } from "../ledger/conversations";
import { orm } from "../ledger/db";
import { events } from "../ledger/schema";
import type { Policy } from "../policy/schema";
import type { MessageFile, RawMessage, VenueKind } from "@bevyl-ai/agent-tools";

export type EventKind = Extract<
  (typeof events.$inferSelect)["kind"],
  "addressed_message" | "observed_message"
>;

export type AddressMode = "mention" | "dm" | "thread_follow";

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
  addressMode: AddressMode | null; // null for observed messages
  files?: MessageFile[];
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
  // Unbound venues: structured log only — no ledger write (no identity to scope).
  onUnboundVenue?: (venueId: string) => void;
}

function bindVenue(policy: Policy, venueId: string, venueKind: VenueKind): string | null {
  for (const identity of policy.identities) {
    if (identity.venueIds.includes(venueId)) return identity.id;
  }
  if (venueKind === "dm" && policy.defaultDmIdentity) return policy.defaultDmIdentity;
  // "*" catch-all after explicit bindings.
  for (const identity of policy.identities) {
    if (identity.venueIds.includes("*")) return identity.id;
  }
  return null;
}

function addressModeOf(
  db: Database,
  identityId: string,
  msg: RawMessage,
  policy: Policy,
): AddressMode | null {
  // Untrusted bots are never addressed (§10.5).
  if (msg.isBot && !policy.trustedBotPrincipals.includes(msg.principalId ?? "")) return null;
  if (msg.venueKind === "dm") return "dm";
  if (msg.mentionsBotId) return "mention";
  // Stepped-out: replies stay observed until mention or own post re-engages.
  if (
    msg.threadRootTs &&
    stanceOf(db, identityId, msg.venueId, msg.threadRootTs).stance === "engaged"
  )
    return "thread_follow";
  return null;
}

export function routeMessage(
  db: Database,
  clock: Clock,
  msg: RawMessage,
  opts: RouterOpts,
): RouteResult {
  if (msg.isBot && msg.principalId === opts.botPrincipalId) return { kind: "ignored_self" };

  const identityId = bindVenue(opts.policy, msg.venueId, msg.venueKind);
  if (!identityId) {
    opts.onUnboundVenue?.(msg.venueId);
    return { kind: "unbound_venue", venueId: msg.venueId };
  }

  const addressMode = addressModeOf(db, identityId, msg, opts.policy);
  const eventKind: EventKind = addressMode ? "addressed_message" : "observed_message";
  const dedupKey = `slack:${msg.venueId}:${msg.deliveryId ?? msg.ts}`;
  const eventId = opts.newEventId();
  const now = clock();

  try {
    orm(db)
      .insert(events)
      .values({
        id: eventId,
        dedupKey,
        kind: eventKind,
        identityId,
        venueId: msg.venueId,
        threadRootId: msg.threadRootTs,
        principalId: msg.principalId,
        payload: {
          text: msg.text,
          ts: msg.ts,
          isBot: msg.isBot,
          ...(msg.principalName ? { principalName: msg.principalName } : {}),
          ...(addressMode ? { addressMode } : {}),
          ...(msg.files?.length ? { files: msg.files } : {}),
        },
        receivedAt: now,
      })
      .run();
  } catch {
    return { kind: "duplicate" };
  }

  if (msg.threadRootTs) rehomeThreadRoot(db, clock, identityId, msg.venueId, msg.threadRootTs);

  writeAudit(db, now, identityId, "event_received", { eventId, kind: eventKind });
  // Addressed → engage; top-level roots on its own ts so later replies count as thread_follow.
  if (addressMode) engage(db, clock, identityId, msg.venueId, msg.threadRootTs ?? msg.ts);

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
    addressMode,
    ...(msg.files?.length ? { files: msg.files } : {}),
  };
  return addressMode ? { kind: "addressed", event } : { kind: "observed", event };
}
