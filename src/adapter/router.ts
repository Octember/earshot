import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { writeAudit } from "../ledger/audit";
import { engage, stanceOf, rehomeThreadRoot } from "../ledger/conversations-stance";
import { orm } from "../ledger/db";
import { events, type Event } from "../ledger/schema";
import type { Policy } from "../policy/schema";
import type { AddressMode } from "../schemas/common";
import type { RawMessage, VenueKind } from "@bevyl-ai/agent-tools";

function bindVenue(policy: Policy, venueId: string, venueKind: VenueKind): string | null {
  for (const identity of policy.identities) {
    if (identity.venueIds.includes(venueId)) return identity.id;
  }
  if (venueKind === "dm" && policy.defaultDmIdentity) return policy.defaultDmIdentity;

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
  if (msg.isBot && !policy.trustedBotPrincipals.includes(msg.principalId ?? "")) return null;
  if (msg.venueKind === "dm") return "dm";
  if (msg.mentionsBotId) return "mention";

  if (
    msg.threadRootTs &&
    stanceOf(db, identityId, msg.venueId, msg.threadRootTs)?.stance === "engaged"
  )
    return "thread_follow";
  return null;
}

export function routeMessage(
  db: Database,
  clock: Clock,
  msg: RawMessage,
  opts: {
    botPrincipalId: string;
    policy: Policy;
    newEventId: () => string;
    onUnboundVenue: (venueId: string) => void;
  },
): Event | null {
  if (msg.isBot && msg.principalId === opts.botPrincipalId) return null;

  const identityId = bindVenue(opts.policy, msg.venueId, msg.venueKind);
  if (!identityId) {
    opts.onUnboundVenue(msg.venueId);
    return null;
  }

  const addressMode = addressModeOf(db, identityId, msg, opts.policy);
  const eventKind: Event["kind"] = addressMode ? "addressed_message" : "observed_message";
  const dedupKey = `slack:${msg.venueId}:${msg.deliveryId ?? msg.ts}`;
  const eventId = opts.newEventId();
  const now = clock();

  let event: Event;
  try {
    event = orm(db)
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
      .returning()
      .get()!;
  } catch {
    return null;
  }

  if (msg.threadRootTs) rehomeThreadRoot(db, identityId, msg.venueId, msg.threadRootTs);

  writeAudit(db, now, identityId, {
    kind: "event_received",
    payload: { eventId, kind: eventKind },
  });

  if (addressMode) engage(db, clock, identityId, msg.venueId, msg.threadRootTs ?? msg.ts);

  return event;
}
