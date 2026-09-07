import { WebAPIPlatformError } from "@slack/web-api";
import { convoKey } from "./inbox";
import { reengage } from "./ledger/stance";
import { log } from "./log";
import type { Service } from "./service";

export interface WakePostContext {
  host: Service;
  identityId: string;
  startSeq: number;
  acts: Set<string>;
  answered: Set<string>;
  moved: Set<string>;
}

export async function postReply(
  ctx: WakePostContext,
  channel: string,
  thread_ts: string | null,
  text: string,
): Promise<string> {
  const key = convoKey(channel, thread_ts);
  const inbox = ctx.host.inboxOf(ctx.identityId);
  const convo = inbox.convos.get(key);
  if (!ctx.moved.has(key) && convo && inbox.arrivedAfter(convo, ctx.startSeq)) {
    ctx.moved.add(key);
    throw new Error(
      "not sent — the conversation moved while you were writing; read what is new and send it again if it still holds.",
    );
  }
  const act = `posted:${key}:${text}`;
  if (ctx.acts.has(act)) return "posted";
  ctx.acts.add(act);
  let posted: string | undefined;
  try {
    posted = (
      await ctx.host.web.chat.postMessage({ channel, text, ...(thread_ts ? { thread_ts } : {}) })
    ).ts;
  } catch (error) {
    log.error("OUTBOUND DELIVERY FAILED — operator must convey this manually", {
      channel,
      thread_ts,
      text,
      error: String(error),
    });
  }
  if (!posted) {
    ctx.acts.delete(act);
    throw new Error("that didn't send — the surface rejected it. try again, or let it go");
  }
  reengage(ctx.host.db, ctx.identityId, channel, thread_ts ?? posted);
  ctx.answered.add(key);
  return "posted";
}

export async function reactInWake(
  ctx: WakePostContext,
  channel: string,
  ts: string,
  emoji: string,
): Promise<void> {
  const act = `reacted:${channel}:${ts}:${emoji}`;
  if (ctx.acts.has(act)) return;
  ctx.acts.add(act);
  try {
    await ctx.host.web.reactions.add({ channel, timestamp: ts, name: emoji });
  } catch (error) {
    if (error instanceof WebAPIPlatformError && error.data.error === "already_reacted") return;
    ctx.acts.delete(act);
    throw error;
  }
}
