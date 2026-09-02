import { closeAttentionItemsForThread } from "./ledger/attention";
import { messagesAfter, type InboxMessage } from "./ledger/inbox";
import {
  recordAct,
  setActTs,
  deleteAct,
  saveDraft,
  engage,
  convoKey,
  recentIdenticalPost,
} from "./ledger/conversations";
import type { Anchor } from "./ledger/tasks";
import { liveTaskStatusAt } from "./ledger/tasks-query";
import { ReplyStream } from "./adapter/reply-stream";
import type { ServiceHost } from "./service-util";

export const POST_DEDUPE_WINDOW_MS = 10 * 60 * 1000;

export type WakePostContext = {
  host: ServiceHost;
  identityId: string;
  wakeId: string;
  effects: unknown[];
  answeredConvos: Set<string>;
  // Conversations owing an answer as of prompt assembly, keyed by convoKey, with the thread their
  // native session lives on. An answer closes the session; the wake end closes what nothing carries.
  openAsks: Map<string, OpenAsk>;
  streamFor: (anchor: Anchor) => ReplyStream;
};

export function createReplyStreams(
  host: ServiceHost,
  pending: InboxMessage[],
): { streamFor: (anchor: Anchor) => ReplyStream; streams: Map<string, ReplyStream> } {
  const streams = new Map<string, ReplyStream>();
  const streamFor = (anchor: Anchor): ReplyStream => {
    const convoKeyStr = convoKey(anchor.venueId, anchor.threadRootId);
    let stream = streams.get(convoKeyStr);
    if (!stream) {
      // Slack streams to a human: the last person who spoke here, or the person a bot-authored
      // line names (a workflow form's "Submitted by <@U…>", an alert's owner).
      const inConvo = pending
        .filter(
          (message) =>
            convoKey(message.venueId ?? "", message.threadRootId ?? message.ts) === convoKeyStr,
        )
        .toReversed();
      const recipient =
        inConvo.find((message) => message.principalId && !message.isBot)?.principalId ??
        inConvo.flatMap((message) => {
          const named = /<@(U\w+)/.exec(message.text)?.[1];
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

export async function settleReplyStreams(streams: Iterable<ReplyStream>): Promise<void> {
  for (const stream of streams) {
    await stream.close().catch(() => {});
  }
}

export type OpenAsk = { venueId: string; threadRootId: string | null; threadTs: string };

// The native session follows the ask: a task still working keeps it processing, a task waiting
// on a human suspends it, and nothing carrying it closes it.
export function settleSession(host: ServiceHost, identityId: string, ask: OpenAsk): void {
  const task = liveTaskStatusAt(host.d.db, identityId, ask.venueId, ask.threadRootId);
  if (task === "open" || task === "active") return;
  const status = task === "waiting" ? "suspended" : "closed";
  void host.d.adapter.setSessionStatus?.(ask.venueId, ask.threadTs, status).catch(() => {});
}

function markAnswered(ctx: WakePostContext, venueId: string, threadRootId: string | null): void {
  const key = convoKey(venueId, threadRootId);
  ctx.answeredConvos.add(key);
  const ask = ctx.openAsks.get(key);
  if (ask) settleSession(ctx.host, ctx.identityId, ask);
}

function isRestartDuplicate(
  ctx: WakePostContext,
  anchor: Anchor,
  text: string,
  actKey: string,
): boolean {
  if (
    !recentIdenticalPost(
      ctx.host.d.db,
      ctx.host.d.clock,
      ctx.identityId,
      anchor.venueId,
      anchor.threadRootId,
      text,
      ctx.wakeId,
      POST_DEDUPE_WINDOW_MS,
      { unlessNewerEventArrived: true },
    )
  ) {
    return false;
  }
  deleteAct(ctx.host.d.db, ctx.wakeId, actKey);
  markAnswered(ctx, anchor.venueId, anchor.threadRootId);
  return true;
}

async function deliverToSlack(
  ctx: WakePostContext,
  anchor: Anchor,
  text: string,
): Promise<{ messageId: string }> {
  const streamedId = await ctx.streamFor(anchor).post(text);
  return streamedId ? { messageId: streamedId } : ctx.host.postMessage(anchor, text);
}

function withholdToDraft(ctx: WakePostContext, anchor: Anchor, text: string): void {
  saveDraft(
    ctx.host.d.db,
    ctx.host.d.clock,
    ctx.identityId,
    anchor.venueId,
    anchor.threadRootId,
    text,
  );
  ctx.effects.push({ kind: "withheld", anchor, text });
}

function completeSuccessfulPost(
  ctx: WakePostContext,
  anchor: Anchor,
  actKey: string,
  text: string,
  messageId: string,
  opts: { markAnswered: boolean; recordPostedEffect: boolean },
): void {
  setActTs(ctx.host.d.db, ctx.wakeId, actKey, messageId, anchor.threadRootId ?? messageId);
  engage(
    ctx.host.d.db,
    ctx.host.d.clock,
    ctx.identityId,
    anchor.venueId,
    anchor.threadRootId ?? messageId,
  );
  if (opts.markAnswered) markAnswered(ctx, anchor.venueId, anchor.threadRootId);
  closeAttentionItemsForThread(
    ctx.host.d.db,
    ctx.host.d.clock,
    ctx.identityId,
    anchor.venueId,
    anchor.threadRootId ?? null,
    "answered in thread",
  );
  if (opts.recordPostedEffect) ctx.effects.push({ kind: "posted", anchor, text });
}

function conversationMovedAfterBatch(
  ctx: WakePostContext,
  batchTail: number,
  anchor: Anchor,
): boolean {
  return messagesAfter(ctx.host.d.db, ctx.identityId, batchTail).some(
    (message) =>
      message.kind === "addressed_message" &&
      (message.venueId ?? "") === anchor.venueId &&
      (anchor.threadRootId === null
        ? message.threadRootId === null
        : (message.threadRootId ?? message.ts) === anchor.threadRootId),
  );
}

export async function flushBufferedReply(
  ctx: WakePostContext,
  batchTail: number,
  anchor: Anchor,
  text: string,
): Promise<void> {
  if (conversationMovedAfterBatch(ctx, batchTail, anchor)) {
    withholdToDraft(ctx, anchor, text);
    return;
  }
  const act = recordAct(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, ctx.wakeId, {
    kind: "posted",
    venueId: anchor.venueId,
    threadRootId: anchor.threadRootId,
    ts: null,
    text,
  });
  if (!act.inserted) return;
  if (isRestartDuplicate(ctx, anchor, text, act.actKey)) return;
  let result: { messageId: string };
  try {
    result = await deliverToSlack(ctx, anchor, text);
  } catch (error) {
    deleteAct(ctx.host.d.db, ctx.wakeId, act.actKey);
    throw error;
  }
  if (result.messageId === "undelivered") {
    deleteAct(ctx.host.d.db, ctx.wakeId, act.actKey);
    withholdToDraft(ctx, anchor, text);
    return;
  }
  completeSuccessfulPost(ctx, anchor, act.actKey, text, result.messageId, {
    markAnswered: false,
    recordPostedEffect: true,
  });
}

export async function postToolsetReply(
  ctx: WakePostContext,
  anchor: Anchor,
  text: string,
): Promise<{ messageId: string }> {
  const act = recordAct(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, ctx.wakeId, {
    kind: "posted",
    venueId: anchor.venueId,
    threadRootId: anchor.threadRootId,
    ts: null,
    text,
  });
  if (!act.inserted) return { messageId: "already-sent-this-wake" };
  if (isRestartDuplicate(ctx, anchor, text, act.actKey)) return { messageId: "already-landed" };
  let result: { messageId: string };
  try {
    result = await deliverToSlack(ctx, anchor, text);
  } catch (error) {
    deleteAct(ctx.host.d.db, ctx.wakeId, act.actKey);
    throw error;
  }
  if (result.messageId === "undelivered") {
    deleteAct(ctx.host.d.db, ctx.wakeId, act.actKey);
    return result;
  }
  completeSuccessfulPost(ctx, anchor, act.actKey, text, result.messageId, {
    markAnswered: true,
    recordPostedEffect: false,
  });
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
