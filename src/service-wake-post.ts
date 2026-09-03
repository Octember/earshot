import type { TurnEffect } from "./schemas/effects";
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
      message.kind === "addressed_message" &&
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
  let result: PostResult;
  try {
    result = await ctx.host.postMessage(anchor, text);
  } catch (error) {
    deleteAct(db, ctx.wakeId, act.actKey);
    throw error;
  }
  if ("held" in result) {
    deleteAct(db, ctx.wakeId, act.actKey);
    return result;
  }
  setActTs(db, ctx.wakeId, act.actKey, result.posted, anchor.threadRootId ?? result.posted);
  ctx.effects.push({ kind: "posted", anchor, text });
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
}
