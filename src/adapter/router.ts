import type { Database } from "bun:sqlite";
import type { MessageEvent } from "@slack/types";
import type { Clock } from "../ledger/clock";
import { hasActedIn } from "../ledger/conversations-stance";
import { orm } from "../ledger/db";
import { events, type Event } from "../ledger/schema";
import type { Policy } from "../policy/schema";

function mentionsByName(text: string, botName: string | null): boolean {
  if (!botName) return false;
  const escaped = botName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`, "i").test(text);
}

function bindVenue(policy: Policy, venueId: string, isDm: boolean): string | null {
  for (const identity of policy.identities) {
    if (identity.venueIds.includes(venueId)) return identity.id;
  }
  if (isDm && policy.defaultDmIdentity) return policy.defaultDmIdentity;
  for (const identity of policy.identities) {
    if (identity.venueIds.includes("*")) return identity.id;
  }
  return null;
}

export function routeMessage(
  db: Database,
  clock: Clock,
  message: MessageEvent,
  opts: {
    botUserId: string;
    botName: string | null;
    nameOf: (principalId: string) => string | null;
    policy: Policy;
    onUnboundVenue: (venueId: string) => void;
  },
): Event | null {
  const botId = "bot_id" in message ? message.bot_id : undefined;
  const user = "user" in message ? message.user : undefined;
  const principalId = user ?? botId ?? null;
  const isBot = botId !== undefined || message.subtype === "bot_message";
  if (isBot && principalId === opts.botUserId) return null;

  const isDm = message.channel_type === "im";
  const identityId = bindVenue(opts.policy, message.channel, isDm);
  if (!identityId) {
    opts.onUnboundVenue(message.channel);
    return null;
  }

  const text = ("text" in message ? message.text : undefined) ?? "";
  const threadTs = "thread_ts" in message ? message.thread_ts : undefined;
  const threadRootId = threadTs && threadTs !== message.ts ? threadTs : null;
  const trusted = !isBot || opts.policy.trustedBotPrincipals.includes(principalId ?? "");
  const mentioned = text.includes(`<@${opts.botUserId}>`) || mentionsByName(text, opts.botName);
  const addressMode: Event["addressMode"] = !trusted
    ? null
    : isDm
      ? "dm"
      : mentioned
        ? "mention"
        : threadRootId && hasActedIn(db, identityId, message.channel, threadRootId)
          ? "thread_follow"
          : null;
  const now = clock();
  const files = "files" in message ? message.files : undefined;

  try {
    return orm(db)
      .insert(events)
      .values({
        dedupKey: `slack:${message.channel}:${message.ts}`,
        identityId,
        venueId: message.channel,
        threadRootId,
        principalId,
        principalName: principalId ? opts.nameOf(principalId) : null,
        ts: message.ts,
        text,
        addressMode,
        files: files?.length ? files : null,
        receivedAt: now,
        judgedAt: addressMode === "mention" || addressMode === "dm" ? now : null,
      })
      .returning()
      .get();
  } catch {
    return null;
  }
}
