// Native streamed reply: lazy-open at first text; cards buffer until then.
import type { SurfaceAdapter } from "@bevyl-ai/agent-tools";
import type { Logger } from "../log";

export interface ChecklistItem {
  text: string;
  done: boolean;
}

export interface ReplyStreamOpts {
  adapter: SurfaceAdapter;
  venueId: string;
  threadTs: string | null; // native streaming requires a thread
  recipient: string | null; // Slack startStream needs the recipient's user id
  log: Logger;
  // Rough word-boundary chunk size for paced appends; omit to append whole posts.
  paceChars?: number;
}

function chunkText(text: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf(" ", size);
    const splitAt = cut > size / 2 ? cut + 1 : size; // no nearby space → hard cut
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
  private cards: ChecklistItem[] = [];
  private wroteText = false;
  // failCards(): unfinished cards flush as "error", not pending-on-stopped-stream.
  private undoneStatus: "pending" | "error" = "pending";

  constructor(private readonly opts: ReplyStreamOpts) {}

  get messageId(): string | null {
    return this.msg?.messageId ?? null;
  }

  get opened(): boolean {
    return this.msg !== null;
  }

  // Opens stream on first post; null if stream cannot start (caller posts plainly).
  post(text: string): Promise<string | null> {
    const first = !this.wroteText;
    this.wroteText = true;
    const paragraph = first ? text : `\n\n${text}`;
    const pieces = this.opts.paceChars ? chunkText(paragraph, this.opts.paceChars) : [paragraph];
    return this.enqueue(async () => {
      const message = await this.open();
      if (!message) return null;
      if (first) await this.flushCards(message.messageId); // plan above the words
      for (const piece of pieces) {
        await this.opts.adapter
          .appendStream!(this.opts.venueId, message.messageId, piece)
          .catch((error: unknown) => {
            this.opts.log.warn("appendStream failed", { venueId: this.opts.venueId, error: String(error) });
          });
      }
      return message.messageId;
    });
  }

  // false → caller must render checklist itself (no cards / stream can't carry them).
  setCards(items: ChecklistItem[]): boolean {
    if (!this.opts.adapter.appendTaskUpdate) return false;
    if (this.failed) return false;
    if (!this.msg && (!this.opts.threadTs || !this.opts.recipient || !this.opts.adapter.startStream)) return false;
    this.cards = items;
    const message = this.msg;
    if (message) void this.enqueue(() => this.flushCards(message.messageId));
    return true;
  }

  clearCards(): void {
    this.cards = [];
  }

  // SUCCEEDED close only — mark unfinished cards done so Slack doesn't show "Something went wrong".
  settleCards(retitle?: (item: ChecklistItem) => string): void {
    const message = this.msg;
    if (!message || !this.cards.some((card) => !card.done)) return;
    this.cards = this.cards.map((card) => (card.done ? card : { text: retitle ? retitle(card) : card.text, done: true }));
    void this.enqueue(() => this.flushCards(message.messageId));
  }

  failCards(): void {
    const message = this.msg;
    if (!message || !this.cards.some((card) => !card.done)) return;
    this.undoneStatus = "error";
    void this.enqueue(() => this.flushCards(message.messageId));
  }

  async close(): Promise<void> {
    await this.queue.catch(() => {});
    if (this.msg) await this.opts.adapter.stopStream?.(this.opts.venueId, this.msg.messageId).catch(() => {});
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async open(): Promise<{ messageId: string } | null> {
    if (this.msg || this.failed) return this.msg;
    const { adapter, venueId, threadTs, recipient, log } = this.opts;
    if (!threadTs || !recipient || !adapter.startStream) {
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

  private async flushCards(messageId: string): Promise<void> {
    const { adapter, venueId, log } = this.opts;
    if (!adapter.appendTaskUpdate) return;
    for (const [index, item] of this.cards.entries()) {
      await adapter
        .appendTaskUpdate(venueId, messageId, { id: `item-${index}`, title: item.text.slice(0, 250), status: item.done ? "complete" : this.undoneStatus })
        .catch((error: unknown) => {
          log.warn("checklist card failed", { venueId, error: String(error) });
        });
    }
  }
}
