import { tool, type DynamicTool } from "@bevyl-ai/agent-tools";
import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { conversations } from "./ledger/schema";
import type { Db, LedgerService } from "./ledger-service";
import { log } from "./log";

export function convoKey(channel: string, threadTs: string | null): string {
  return `${channel}|${threadTs ?? ""}`;
}

export class Acts {
  acted = false;
  readonly answered = new Set<string>();
  readonly moved = new Set<string>();

  constructor(
    private readonly web: WebClient,
    private readonly db: Db,
    private readonly ledger: LedgerService,
  ) {}

  get tools(): DynamicTool[] {
    return [
      tool(
        "reply",
        "Post a message; omit thread_ts for channel level.",
        z.object({ text: z.string(), channel: z.string(), thread_ts: z.string().optional() }),
        ({ text, channel, thread_ts }) => this.reply(channel, thread_ts ?? null, text),
      ),
      tool(
        "react",
        "React to a message.",
        z.object({
          emoji: z.string().transform((s) => s.replaceAll(":", "").trim()),
          channel: z.string(),
          ts: z.string(),
        }),
        async ({ emoji, channel, ts }) => {
          await this.react(channel, ts, emoji);
          return `reacted :${emoji}:`;
        },
      ),
    ];
  }

  async reply(channel: string, thread_ts: string | null, text: string): Promise<string> {
    const key = convoKey(channel, thread_ts);
    const arrived = thread_ts
      ? this.db.query.conversations
          .findFirst({
            where: and(eq(conversations.channel, channel), eq(conversations.threadTs, thread_ts)),
          })
          .sync()
      : undefined;
    if (!this.moved.has(key) && arrived?.direct) {
      this.moved.add(key);
      throw new Error(
        "not sent — the conversation moved while you were writing; read what is new and send it again if it still holds.",
      );
    }
    let posted: string | undefined;
    try {
      posted = (
        await this.web.chat.postMessage({ channel, text, ...(thread_ts ? { thread_ts } : {}) })
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
      throw new Error("that didn't send — the surface rejected it. try again, or let it go");
    }
    this.ledger.unmute(channel, thread_ts ?? posted);
    this.answered.add(key);
    this.acted = true;
    return "posted";
  }

  async react(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.web.reactions.add({ channel, timestamp: ts, name: emoji });
    } catch (error) {
      if (!(error instanceof WebAPIPlatformError && error.data.error === "already_reacted"))
        throw error;
    }
    this.acted = true;
  }
}
