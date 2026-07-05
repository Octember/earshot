// One native streamed reply message (chat.startStream → appendStream/appendTaskUpdate →
// stopStream). Interactive replies and execution reporting both speak through this — the single
// implementation of the "one message per conversation turn / per execution" delivery contract:
//
// - The stream opens LAZILY at the first text post. An open-but-empty stream renders a literal
//   italic "Thinking…" placeholder bubble, and checklist cards alone must never create (and
//   notify on) a message.
// - Checklist cards BUFFER until the first text materializes the message, then flush above the
//   words, so the reader gets progress + content as one notification. Later card updates edit the
//   same cards in place (stable per-index ids).
// - All writes are serialized through one internal queue, so text and cards land in order even
//   when producers fire synchronously (e.g. from a runtime event stream).
// - If the stream cannot start (no thread, no recipient, the surface refuses), the failure
//   latches: post() returns null and the caller delivers via plain postMessage instead.
import type { SurfaceAdapter } from "./types";
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
  // If set, split posted text into word-boundary pieces of roughly this many chars — appended
  // sequentially they give the streamed-in feel (each append is its own HTTP call, so pacing
  // comes for free). Omit to append each post as one piece.
  paceChars?: number;
}

// Split text into word-boundary pieces of roughly `size` chars.
function chunkText(text: string, size: number): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > size) {
    const cut = rest.lastIndexOf(" ", size);
    const at = cut > size / 2 ? cut + 1 : size; // no nearby space → hard cut
    pieces.push(rest.slice(0, at));
    rest = rest.slice(at);
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

  constructor(private readonly opts: ReplyStreamOpts) {}

  // The streamed message's id, once the first post materialized it.
  get messageId(): string | null {
    return this.msg?.messageId ?? null;
  }

  get opened(): boolean {
    return this.msg !== null;
  }

  // Append a paragraph of text, opening the stream first if this is the first post. Resolves to
  // the streamed message id, or null when no stream could start (caller posts plainly instead).
  post(text: string): Promise<string | null> {
    const first = !this.wroteText;
    this.wroteText = true;
    const paragraph = first ? text : `\n\n${text}`;
    const pieces = this.opts.paceChars ? chunkText(paragraph, this.opts.paceChars) : [paragraph];
    return this.enqueue(async () => {
      const m = await this.open();
      if (!m) return null;
      if (first) await this.flushCards(m.messageId); // plan above the words
      for (const piece of pieces) {
        await this.opts.adapter
          .appendStream!(this.opts.venueId, m.messageId, piece)
          .catch((e) => this.opts.log.warn("appendStream failed", { venueId: this.opts.venueId, error: String(e) }));
      }
      return m.messageId;
    });
  }

  // Replace the checklist. Returns false when the surface has no native cards (the caller falls
  // back to its own checklist rendering). Buffered until the message exists; live afterwards.
  setCards(items: ChecklistItem[]): boolean {
    if (!this.opts.adapter.appendTaskUpdate) return false;
    this.cards = items;
    const m = this.msg;
    if (m) void this.enqueue(() => this.flushCards(m.messageId));
    return true;
  }

  // Drop buffered cards so they never render — a failing turn must not flush a plan box (a
  // checked-off plan over a failure line is a lie). Cards already rendered stay as they are.
  clearCards(): void {
    this.cards = [];
  }

  // Mark every unfinished card complete (optionally retitled, e.g. "… — ⏸ parked") before the
  // stream closes: Slack renders a pending card on a stopped stream as an error plan titled
  // "Something went wrong" — a visual failure this close must not imply.
  settleCards(retitle?: (item: ChecklistItem) => string): void {
    const m = this.msg;
    if (!m || !this.cards.some((c) => !c.done)) return;
    this.cards = this.cards.map((c) => (c.done ? c : { text: retitle ? retitle(c) : c.text, done: true }));
    void this.enqueue(() => this.flushCards(m.messageId));
  }

  // Drain pending writes, then stop the stream (if one ever opened).
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
      } catch (e) {
        log.warn("chat.startStream threw", { attempt, venueId, threadTs, error: String(e) });
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
    for (const [i, item] of this.cards.entries()) {
      await adapter
        .appendTaskUpdate(venueId, messageId, { id: `item-${i}`, title: item.text.slice(0, 250), status: item.done ? "complete" : "pending" })
        .catch((e) => log.warn("checklist card failed", { venueId, error: String(e) }));
    }
  }
}
