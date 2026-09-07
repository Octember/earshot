import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import { and, eq } from "drizzle-orm";
import { inject, singleton } from "tsyringe";
import { conversations } from "./ledger/schema";
import { convoKey, DB, LedgerService, type Db } from "./ledger-service";
import { log } from "./log";

@singleton()
export class Acts {
  acted = false;
  answered = new Set<string>();
  moved = new Set<string>();

  constructor(
    private readonly web: WebClient,
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
  ) {}

  begin(): void {
    this.acted = false;
    this.answered = new Set();
    this.moved = new Set();
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
