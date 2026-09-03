import type { TurnEffect } from "./schemas/effects";
import { closeAttentionItemsForThread } from "./ledger/attention";
import { messagesAfter } from "./ledger/inbox";
import type { Event } from "./ledger/schema";
import {
  recordAct,
  setActTs,
  deleteAct,
  saveDraft,
  recentIdenticalPost,
} from "./ledger/conversations-acts";
import { engage, convoKey } from "./ledger/conversations-stance";
import type { Anchor } from "./ledger/tasks-types";
import { liveTaskStatusAt } from "./ledger/tasks-query";
import { ReplyStream } from "./adapter/reply-stream";
import type { Service } from "./service";

const POST_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export type WakePostContext = {
  host: Service;
  identityId: string;
  wakeId: string;
  effects: TurnEffect[];
  answeredConvos: Set<string>;

  openAsks: Map<string, OpenAsk>;
  streamFor: (anchor: Anchor) => ReplyStream;
};

export function createReplyStreams(
  host: Service,
  pending: Event[],
): { streamFor: (anchor: Anchor) => ReplyStream; streams: Map<string, ReplyStream> } {
  const streams = new Map<string, ReplyStream>();
  const streamFor = (anchor: Anchor): ReplyStream => {
    const convoKeyStr = convoKey(anchor.venueId, anchor.threadRootId);
    let stream = streams.get(convoKeyStr);
    if (!stream) {
      const inConvo = pending
        .filter(
          (message) =>
            convoKey(message.venueId, message.threadRootId ?? message.payload.ts) === convoKeyStr,
        )
        .toReversed();
      const recipient =
        inConvo.find((message) => message.principalId && !message.payload.isBot)?.principalId ??
        inConvo.flatMap((message) => {
          const named = /<@(U\w+)/.exec(message.payload.text)?.[1];
          return named ? [named] : [];
        })[0] ??
        null;
      stream = new ReplyStream({
        adapter: host.d.adapter,
        venueId: anchor.venueId,
        threadTs: anchor.threadRootId,
        recipient,
        log: host.log,
      });
      streams.set(convoKeyStr, stream);
    }
    return stream;
  };
  return { streamFor, streams };
}

export interface OpenAsk extends Anchor {
  threadTs: string;
}

type AskOutcome = "answered" | "awaiting" | "unanswered";

export function settleSession(
  host: Service,
  identityId: string,
  ask: OpenAsk,
  outcome: AskOutcome,
): void {
  const task = liveTaskStatusAt(host.d.db, identityId, ask.venueId, ask.threadRootId);
  if (task === "open" || task === "active") return;
  const status =
    task === "waiting" || outcome === "awaiting"
      ? "suspended"
      : outcome === "answered"
        ? "active"
        : "closed";
  void host.d.adapter.setSessionStatus(ask.venueId, ask.threadTs, status).catch(() => {});
}

function settleAsk(
  ctx: WakePostContext,
  venueId: string,
  threadRootId: string | null,
  outcome: AskOutcome,
): void {
  const key = convoKey(venueId, threadRootId);
  for (const [askKey, ask] of ctx.openAsks) {
    if (ask.venueId !== venueId) continue;
    if (askKey !== key && ask.threadTs !== threadRootId) continue;
    settleSession(ctx.host, ctx.identityId, ask, outcome);
    ctx.openAsks.delete(askKey);
  }
}

function markAnswered(ctx: WakePostContext, venueId: string, threadRootId: string | null): void {
  ctx.answeredConvos.add(convoKey(venueId, threadRootId));
  settleAsk(ctx, venueId, threadRootId, "answered");
}

export async function postReply(
  ctx: WakePostContext,
  anchor: Anchor,
  text: string,
  opts: { awaitingReply?: boolean | undefined; bufferedAfter?: number | undefined } = {},
): Promise<{ messageId: string }> {
  const { db, clock } = ctx.host.d;
  const withhold = () => {
    saveDraft(db, clock, ctx.identityId, anchor.venueId, anchor.threadRootId, text);
    ctx.effects.push({ kind: "withheld", anchor, text });
    return { messageId: "undelivered" };
  };
  if (
    opts.bufferedAfter !== undefined &&
    messagesAfter(db, ctx.identityId, opts.bufferedAfter).some(
      (message) =>
        message.kind === "addressed_message" &&
        message.venueId === anchor.venueId &&
        (anchor.threadRootId === null
          ? message.threadRootId === null
          : (message.threadRootId ?? message.payload.ts) === anchor.threadRootId),
    )
  )
    return withhold();
  const act = recordAct(db, clock, ctx.identityId, ctx.wakeId, {
    kind: "posted",
    venueId: anchor.venueId,
    threadRootId: anchor.threadRootId,
    ts: null,
    text,
  });
  if (!act.inserted) return { messageId: "already-sent-this-wake" };
  if (
    recentIdenticalPost(
      db,
      clock,
      ctx.identityId,
      anchor.venueId,
      anchor.threadRootId,
      text,
      ctx.wakeId,
      POST_DEDUPE_WINDOW_MS,
      {
        unlessNewerEventArrived: true,
      },
    )
  ) {
    deleteAct(db, ctx.wakeId, act.actKey);
    markAnswered(ctx, anchor.venueId, anchor.threadRootId);
    return { messageId: "already-landed" };
  }
  let result: { messageId: string };
  try {
    const streamedId = await ctx.streamFor(anchor).post(text);
    result = streamedId ? { messageId: streamedId } : await ctx.host.postMessage(anchor, text);
  } catch (error) {
    deleteAct(db, ctx.wakeId, act.actKey);
    throw error;
  }
  if (result.messageId === "undelivered") {
    deleteAct(db, ctx.wakeId, act.actKey);
    return opts.bufferedAfter === undefined ? result : withhold();
  }
  setActTs(db, ctx.wakeId, act.actKey, result.messageId, anchor.threadRootId ?? result.messageId);
  engage(db, clock, ctx.identityId, anchor.venueId, anchor.threadRootId ?? result.messageId);
  settleAsk(ctx, anchor.venueId, anchor.threadRootId, opts.awaitingReply ? "awaiting" : "answered");
  if (opts.bufferedAfter === undefined)
    ctx.answeredConvos.add(convoKey(anchor.venueId, anchor.threadRootId));
  else ctx.effects.push({ kind: "posted", anchor, text });
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

export async function postFallbackReply(
  ctx: WakePostContext,
  anchor: Anchor,
  text: string,
): Promise<void> {
  const act = recordAct(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, ctx.wakeId, {
    kind: "posted",
    venueId: anchor.venueId,
    threadRootId: anchor.threadRootId,
    ts: null,
    text,
  });
  if (
    act.inserted &&
    recentIdenticalPost(
      ctx.host.d.db,
      ctx.host.d.clock,
      ctx.identityId,
      anchor.venueId,
      anchor.threadRootId,
      text,
      ctx.wakeId,
      POST_DEDUPE_WINDOW_MS,
      { unlessNewerEventArrived: false },
    )
  ) {
    deleteAct(ctx.host.d.db, ctx.wakeId, act.actKey);
  } else if (act.inserted) {
    try {
      const result = await ctx.host.postMessage(anchor, text);
      if (result.messageId === "undelivered") deleteAct(ctx.host.d.db, ctx.wakeId, act.actKey);
      else setActTs(ctx.host.d.db, ctx.wakeId, act.actKey, result.messageId);
    } catch {
      deleteAct(ctx.host.d.db, ctx.wakeId, act.actKey);
    }
  }
}

export async function reactInWake(
  ctx: WakePostContext,
  venueId: string,
  ts: string,
  emoji: string,
  threadRootId: string | null,
): Promise<void> {
  const residence = threadRootId ?? ts;
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
  markAnswered(ctx, venueId, residence);
  closeAttentionItemsForThread(
    ctx.host.d.db,
    ctx.host.d.clock,
    ctx.identityId,
    venueId,
    residence,
    "reacted in thread",
  );
}
