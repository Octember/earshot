import type { TurnEffect } from "./schemas/effects";
import { WebAPIPlatformError } from "@slack/web-api";
import { messagesAfter } from "./ledger/inbox";
import { recordAct, setActTs, deleteAct } from "./ledger/conversations-acts";
import { conversationOfEvent, convoKey } from "./ledger/conversations-stance";
import type { Anchor } from "./ledger/tasks-types";
import type { Service } from "./service";

export type PostResult = { posted: string } | { held: "moved" | "undelivered" | "duplicate" };

export type WakePostContext = {
  host: Service;
  identityId: string;
  wakeId: string;
  batchTail: number;
  effects: TurnEffect[];
  moved: Set<string>;
};

export function answeredKeys(ctx: WakePostContext): Set<string> {
  return new Set(
    ctx.effects.flatMap((effect) =>
      effect.kind === "posted" ? [convoKey(effect.anchor.venueId, effect.anchor.threadRootId)] : [],
    ),
  );
}

function conversationMoved(ctx: WakePostContext, anchor: Anchor): boolean {
  const key = convoKey(anchor.venueId, anchor.threadRootId);
  return messagesAfter(ctx.host.d.db, ctx.identityId, ctx.batchTail).some(
    (message) =>
      message.addressMode !== null &&
      message.venueId === anchor.venueId &&
      (anchor.threadRootId === null
        ? message.threadRootId === null
        : convoKey(message.venueId, conversationOfEvent(message).threadRootId) === key),
  );
}

export async function postReply(
  ctx: WakePostContext,
  anchor: Anchor,
  text: string,
): Promise<PostResult> {
  const { db, clock } = ctx.host.d;
  const key = convoKey(anchor.venueId, anchor.threadRootId);
  if (!ctx.moved.has(key) && conversationMoved(ctx, anchor)) {
    ctx.moved.add(key);
    return { held: "moved" };
  }
  const act = recordAct(db, clock, ctx.identityId, ctx.wakeId, {
    kind: "posted",
    venueId: anchor.venueId,
    threadRootId: anchor.threadRootId,
    ts: null,
    text,
  });
  if (!act.inserted) return { held: "duplicate" };
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
    deleteAct(db, ctx.wakeId, act.actKey);
    return { held: "undelivered" };
  }
  setActTs(db, ctx.wakeId, act.actKey, posted, anchor.threadRootId ?? posted);
  ctx.effects.push({ kind: "posted", anchor, text });
  return { posted };
}

export async function reactInWake(
  ctx: WakePostContext,
  venueId: string,
  ts: string,
  emoji: string,
  threadRootId: string | null,
): Promise<void> {
  const act = recordAct(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, ctx.wakeId, {
    kind: "reacted",
    venueId,
    threadRootId,
    ts,
    text: emoji,
  });
  if (!act.inserted) return;
  try {
    await ctx.host.d.web.reactions.add({ channel: venueId, timestamp: ts, name: emoji });
  } catch (error) {
    if (error instanceof WebAPIPlatformError && error.data.error === "already_reacted") return;
    deleteAct(ctx.host.d.db, ctx.wakeId, act.actKey);
    throw error;
  }
}
