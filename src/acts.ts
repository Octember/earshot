import { WebAPIPlatformError, type WebClient } from "@slack/web-api";
import { and, eq } from "drizzle-orm";
import { conversations } from "./ledger/schema";
import type { Db, LedgerService } from "./ledger-service";
import { log } from "./log";

export function convoKey(channel: string, threadTs: string | null): string {
  return `${channel}|${threadTs ?? ""}`;
}

export class Acts {
  readonly done = new Set<string>();
  readonly answered = new Set<string>();
  readonly moved = new Set<string>();

  constructor(
    private readonly web: WebClient,
    private readonly db: Db,
    private readonly ledger: LedgerService,
  ) {}

  note(act: string): void {
    this.done.add(act);
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
    const act = `posted:${key}:${text}`;
    if (this.done.has(act)) return "posted";
    this.done.add(act);
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
      this.done.delete(act);
      throw new Error("that didn't send — the surface rejected it. try again, or let it go");
    }
    this.ledger.unmute(channel, thread_ts ?? posted);
    this.answered.add(key);
    return "posted";
  }

  async react(channel: string, ts: string, emoji: string): Promise<void> {
    const act = `reacted:${channel}:${ts}:${emoji}`;
    if (this.done.has(act)) return;
    this.done.add(act);
    try {
      await this.web.reactions.add({ channel, timestamp: ts, name: emoji });
    } catch (error) {
      if (error instanceof WebAPIPlatformError && error.data.error === "already_reacted") return;
      this.done.delete(act);
      throw error;
    }
  }
}
