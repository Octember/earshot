import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import { inject, singleton } from "tsyringe";
import { conversations, type Conversation } from "./ledger/schema";
import { DB, LedgerService, thread, type Db } from "./ledger-service";
import { log } from "./log";

type Thread = Pick<Conversation, "channel" | "threadTs">;

const key = ({ channel, threadTs }: Thread) => `${channel}|${threadTs}`;

@singleton()
export class Voice {
  acted = false;
  private replied = new Set<string>();
  private bounced = new Set<string>();

  constructor(
    private readonly web: WebClient,
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
  ) {}

  begin(): void {
    this.acted = false;
    this.replied = new Set();
    this.bounced = new Set();
  }

  status(convo: Thread): "active" | "closed" {
    return this.replied.has(key(convo)) ? "active" : "closed";
  }

  async reply(channel: string, thread_ts: string | null, text: string): Promise<string> {
    if (thread_ts) {
      const convo = { channel, threadTs: thread_ts };
      const arrived = this.db.query.conversations
        .findFirst({ where: thread(conversations, channel, thread_ts) })
        .sync();
      if (arrived?.direct && !this.bounced.has(key(convo))) {
        this.bounced.add(key(convo));
        throw new Error(
          "not sent — the conversation moved while you were writing; read what is new and send it again if it still holds.",
        );
      }
    }
    return this.post(channel, thread_ts, text);
  }

  async post(channel: string, thread_ts: string | null, text: string): Promise<string> {
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
    this.replied.add(key({ channel, threadTs: thread_ts ?? posted }));
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
