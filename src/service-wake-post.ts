import type { TurnEffect } from "./schemas/effects";
import { closeAttentionItemsForThread } from "./ledger/attention";
import { messagesAfter } from "./ledger/inbox";
import { recordAct, setActTs, deleteAct } from "./ledger/conversations-acts";
import { engage, convoKey } from "./ledger/conversations-stance";
import type { Anchor } from "./ledger/tasks-types";
import type { Service } from "./service";

export type WakePostContext = {
  host: Service;
  identityId: string;
  wakeId: string;
  batchTail: number;
  effects: TurnEffect[];
  moved: Set<string>;
};

function conversationMoved(ctx: WakePostContext, anchor: Anchor): boolean {
  return messagesAfter(ctx.host.d.db, ctx.identityId, ctx.batchTail).some(
    (message) =>
      message.kind === "addressed_message" &&
      message.venueId === anchor.venueId &&
      (anchor.threadRootId === null
        ? message.threadRootId === null
        : (message.threadRootId ?? message.payload.ts) === anchor.threadRootId),
  );
}

export async function postReply(
  ctx: WakePostContext,
  anchor: Anchor,
  text: string,
): Promise<{ messageId: string }> {
  const { db, clock } = ctx.host.d;
  const key = convoKey(anchor.venueId, anchor.threadRootId);
  if (!ctx.moved.has(key) && conversationMoved(ctx, anchor)) {
    ctx.moved.add(key);
    return { messageId: "moved" };
  }
  const act = recordAct(db, clock, ctx.identityId, ctx.wakeId, {
    kind: "posted",
    venueId: anchor.venueId,
    threadRootId: anchor.threadRootId,
    ts: null,
    text,
  });
  if (!act.inserted) return { messageId: "already-sent-this-wake" };
  let result: { messageId: string };
  try {
    result = await ctx.host.postMessage(anchor, text);
  } catch (error) {
    deleteAct(db, ctx.wakeId, act.actKey);
    throw error;
  }
  if (result.messageId === "undelivered") {
    deleteAct(db, ctx.wakeId, act.actKey);
    return result;
  }
  setActTs(db, ctx.wakeId, act.actKey, result.messageId, anchor.threadRootId ?? result.messageId);
  engage(db, clock, ctx.identityId, anchor.venueId, anchor.threadRootId ?? result.messageId);
  ctx.effects.push({ kind: "posted", anchor, text });
  closeAttentionItemsForThread(
    db,
    clock,
    ctx.identityId,
    anchor.venueId,
    anchor.threadRootId ?? null,
    "answered in thread",
  );
  return result;
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
    await ctx.host.d.adapter.addReaction(venueId, ts, emoji);
  } catch (error) {
    deleteAct(ctx.host.d.db, ctx.wakeId, act.actKey);
    throw error;
  }
  closeAttentionItemsForThread(
    ctx.host.d.db,
    ctx.host.d.clock,
    ctx.identityId,
    venueId,
    threadRootId ?? ts,
    "reacted in thread",
  );
}
