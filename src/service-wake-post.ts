import type { TurnEffect } from "./schemas/effects";
import { WebAPIPlatformError } from "@slack/web-api";
import { convoKey, type Inbox } from "./inbox";
import { reengage } from "./ledger/stance";
import type { Anchor } from "./ledger/tasks-types";
import type { Service } from "./service";

export type PostResult = { posted: string } | { held: "moved" | "undelivered" | "duplicate" };

export interface WakePostContext {
  host: Service;
  identityId: string;
  inbox: Inbox;
  startSeq: number;
  effects: TurnEffect[];
  moved: Set<string>;
  done: Set<string>;
}

export function answeredKeys(ctx: WakePostContext): Set<string> {
  return new Set(
    ctx.effects.flatMap((effect) =>
      effect.kind === "posted" ? [convoKey(effect.anchor.venueId, effect.anchor.threadRootId)] : [],
    ),
  );
}

export async function postReply(
  ctx: WakePostContext,
  anchor: Anchor,
  text: string,
): Promise<PostResult> {
  const key = convoKey(anchor.venueId, anchor.threadRootId);
  const convo = ctx.inbox.convos.get(key);
  if (!ctx.moved.has(key) && convo && ctx.inbox.arrivedAfter(convo, ctx.startSeq)) {
    ctx.moved.add(key);
    return { held: "moved" };
  }
  const actKey = `posted:${key}:${text}`;
  if (ctx.done.has(actKey)) return { held: "duplicate" };
  ctx.done.add(actKey);
  let posted: string | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5 && !posted; attempt++) {
    try {
      posted = (
        await ctx.host.d.web.chat.postMessage({
          channel: anchor.venueId,
          text,
          ...(anchor.threadRootId ? { thread_ts: anchor.threadRootId } : {}),
        })
      ).ts;
    } catch (error) {
      lastError = error;
      if (attempt < 5)
        await new Promise<void>((resolve) => {
          setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 30_000));
        });
    }
  }
  if (!posted) {
    ctx.host.log.error("OUTBOUND DELIVERY FAILED — operator must convey this manually", {
      anchor,
      text,
      error: String(lastError),
    });
    ctx.done.delete(actKey);
    return { held: "undelivered" };
  }
  reengage(ctx.host.d.db, ctx.identityId, anchor.venueId, anchor.threadRootId ?? posted);
  ctx.effects.push({ kind: "posted", anchor, text });
  return { posted };
}

export async function reactInWake(
  ctx: WakePostContext,
  channel: string,
  ts: string,
  emoji: string,
): Promise<void> {
  const actKey = `reacted:${channel}:${ts}:${emoji}`;
  if (ctx.done.has(actKey)) return;
  ctx.done.add(actKey);
  try {
    await ctx.host.d.web.reactions.add({ channel, timestamp: ts, name: emoji });
  } catch (error) {
    if (error instanceof WebAPIPlatformError && error.data.error === "already_reacted") return;
    ctx.done.delete(actKey);
    throw error;
  }
}
