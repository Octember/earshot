import type { SlackAdapter } from "@bevyl-ai/agent-tools";
import type { Logger } from "../log";

function chunkText(text: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf(" ", size);
    const splitAt = cut > size / 2 ? cut + 1 : size;
    pieces.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt);
  }
  if (rest) pieces.push(rest);
  return pieces;
}

export class ReplyStream {
  private msg: { messageId: string } | null = null;
  private failed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private wroteText = false;

  constructor(
    private readonly opts: {
      adapter: SlackAdapter;
      venueId: string;
      threadTs: string | null;
      recipient: string | null;
      log: Logger;

      paceChars?: number;
    },
  ) {}

  get messageId(): string | null {
    return this.msg?.messageId ?? null;
  }

  get opened(): boolean {
    return this.msg !== null;
  }

  post(text: string): Promise<string | null> {
    const first = !this.wroteText;
    this.wroteText = true;
    const paragraph = first ? text : `\n\n${text}`;
    const pieces = this.opts.paceChars ? chunkText(paragraph, this.opts.paceChars) : [paragraph];
    return this.enqueue(async () => {
      const message = await this.open();
      if (!message) return null;
      for (const piece of pieces) {
        await this.opts.adapter
          .appendStream(this.opts.venueId, message.messageId, piece)
          .catch((error: unknown) => {
            this.opts.log.warn("appendStream failed", {
              venueId: this.opts.venueId,
              error: String(error),
            });
          });
      }
      return message.messageId;
    });
  }

  async close(): Promise<void> {
    await this.queue.catch(() => {});
    if (this.msg)
      await this.opts.adapter.stopStream(this.opts.venueId, this.msg.messageId).catch(() => {});
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async open(): Promise<{ messageId: string } | null> {
    if (this.msg || this.failed) return this.msg;
    const { adapter, venueId, threadTs, recipient, log } = this.opts;
    if (!threadTs || !recipient) {
      this.failed = true;
      return null;
    }
    for (let attempt = 0; attempt < 2 && !this.msg; attempt++) {
      try {
        this.msg = await adapter.startStream(venueId, threadTs, recipient);
      } catch (error) {
        log.warn("chat.startStream threw", { attempt, venueId, threadTs, error: String(error) });
      }
    }
    if (!this.msg) {
      this.failed = true;
      log.warn("no reply stream — delivering via plain post", { venueId, threadTs });
    }
    return this.msg;
  }
}
