import { WebAPIPlatformError } from "@slack/web-api";
import { convoKey, type Inbox } from "./inbox";
import { reengage } from "./ledger/stance";
import { log } from "./log";
import type { Service } from "./service";

export interface WakePostContext {
  host: Service;
  identityId: string;
  inbox: Inbox;
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
): Promise<{ success: boolean; output: string }> {
  const key = convoKey(channel, thread_ts);
  const convo = ctx.inbox.convos.get(key);
  if (!ctx.moved.has(key) && convo && ctx.inbox.arrivedAfter(convo, ctx.startSeq)) {
    ctx.moved.add(key);
    return {
      success: false,
      output:
        "not sent — the conversation moved while you were writing; read what is new and send it again if it still holds.",
    };
  }
  const act = `posted:${key}:${text}`;
  if (ctx.acts.has(act)) return { success: true, output: "posted" };
  ctx.acts.add(act);
  let posted: string | undefined;
  let lastError: unknown;
  for (let attempt = 1; attempt <= 5 && !posted; attempt++) {
    try {
      posted = (
        await ctx.host.web.chat.postMessage({ channel, text, ...(thread_ts ? { thread_ts } : {}) })
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
    log.error("OUTBOUND DELIVERY FAILED — operator must convey this manually", {
      channel,
      thread_ts,
      text,
      error: String(lastError),
    });
    ctx.acts.delete(act);
    return {
      success: false,
      output: "that didn't send — the surface rejected it after retries. try again, or let it go",
    };
  }
  reengage(ctx.host.db, ctx.identityId, channel, thread_ts ?? posted);
  ctx.answered.add(key);
  return { success: true, output: "posted" };
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
