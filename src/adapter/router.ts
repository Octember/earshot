import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { hasActedIn } from "../ledger/conversations-stance";
import { orm } from "../ledger/db";
import { events, type Event } from "../ledger/schema";
import type { Policy } from "../policy/schema";
import type { RawMessage, VenueKind } from "./slack";

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
): Event["addressMode"] {
  if (msg.isBot && !policy.trustedBotPrincipals.includes(msg.principalId ?? "")) return null;
  if (msg.venueKind === "dm") return "dm";
  if (msg.mentionsBotId) return "mention";

  if (msg.threadRootTs && hasActedIn(db, identityId, msg.venueId, msg.threadRootTs))
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
  const dedupKey = `slack:${msg.venueId}:${msg.ts}`;
  const now = clock();

  let event: Event;
  try {
    event = orm(db)
      .insert(events)
      .values({
        dedupKey,
        identityId,
        venueId: msg.venueId,
        threadRootId: msg.threadRootTs,
        principalId: msg.principalId,
        principalName: msg.principalName ?? null,
        ts: msg.ts,
        text: msg.text,
        addressMode,
        files: msg.files?.length ? msg.files : null,
        receivedAt: now,
        judgedAt: addressMode === "mention" || addressMode === "dm" ? now : null,
      })
      .returning()
      .get()!;
  } catch {
    return null;
  }

  return event;
}
