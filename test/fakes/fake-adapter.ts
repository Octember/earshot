import type { MessageFile, PostResult, RawMessage, SurfaceAdapter } from "../../src/adapter/types";

// A scripted stand-in for SurfaceAdapter (real: SlackAdapter) — lets tests drive the router +
// turn-admission + outbound pipeline end-to-end without a live Slack workspace.
export class FakeAdapter implements SurfaceAdapter {
  posts: { venueId: string; threadRootTs: string | null; text: string }[] = [];
  reactions: { venueId: string; messageId: string; emoji: string }[] = [];
  statuses: { venueId: string; threadRootTs: string | null; status: string }[] = [];
  private handlers: Array<(msg: RawMessage) => void> = [];
  private nextTs = 1;

  async start(): Promise<void> {}
  stop(): void {}

  onMessage(handler: (msg: RawMessage) => void): void {
    this.handlers.push(handler);
  }

  // Test helper: simulate an inbound message arriving over the wire.
  emit(msg: RawMessage): void {
    for (const handler of this.handlers) handler(msg);
  }

  updates: { venueId: string; messageId: string; text: string }[] = [];

  async postMessage(venueId: string, threadRootTs: string | null, text: string): Promise<PostResult> {
    this.posts.push({ venueId, threadRootTs, text });
    return { messageId: String(this.nextTs++) };
  }

  async updateMessage(venueId: string, messageId: string, text: string): Promise<void> {
    this.updates.push({ venueId, messageId, text });
  }

  async addReaction(venueId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ venueId, messageId, emoji });
  }

  // Thread context: tests seed threads[threadTs] with messages returned by readThread.
  threads = new Map<string, { user: string | null; text: string; ts: string; files?: MessageFile[] }[]>();
  async readThread(_venueId: string, threadTs: string, _limit?: number): Promise<{ user: string | null; text: string; ts: string; files?: MessageFile[] }[]> {
    return this.threads.get(threadTs) ?? [];
  }

  permalink(venueId: string, messageId: string): string {
    return `https://fake.slack/archives/${venueId}/p${messageId.replace(".", "")}`;
  }

  // Vision: served byte payloads by urlPrivate; tests seed this map.
  fileBytes = new Map<string, Uint8Array>();
  downloads: string[] = [];
  async downloadFile(urlPrivate: string): Promise<Uint8Array> {
    this.downloads.push(urlPrivate);
    const bytes = this.fileBytes.get(urlPrivate);
    if (!bytes) throw new Error("file download returned HTML — the Slack app likely lacks the files:read scope");
    return bytes;
  }

  async setTypingStatus(venueId: string, threadRootTs: string | null, status: string): Promise<void> {
    this.statuses.push({ venueId, threadRootTs, status });
  }

  // Native streaming capture (Slack chat.startStream/appendStream/stopStream). Each stream
  // accumulates its appended text so a test can assert the final rendered reply + delta count.
  streams: { messageId: string; venueId: string; threadTs: string; recipient: string; text: string; appends: number; stopped: boolean }[] = [];
  // Task cards appended to streams (Slack task_update chunks), in arrival order.
  taskCards: { messageId: string; id: string; title: string; status: string }[] = [];
  failStreams = false; // simulate chat.startStream being unavailable/failing

  async startStream(venueId: string, threadRootTs: string, recipientUserId: string): Promise<{ messageId: string } | null> {
    if (this.failStreams) return null;
    const messageId = `stream-${this.nextTs++}`;
    this.streams.push({ messageId, venueId, threadTs: threadRootTs, recipient: recipientUserId, text: "", appends: 0, stopped: false });
    return { messageId };
  }

  async appendTaskUpdate(_venueId: string, messageId: string, task: { id: string; title: string; status: string }): Promise<void> {
    this.taskCards.push({ messageId, ...task });
  }

  async appendStream(_venueId: string, messageId: string, markdownDelta: string): Promise<void> {
    const s = this.streams.find((x) => x.messageId === messageId);
    if (s) {
      s.text += markdownDelta;
      s.appends++;
    }
  }

  async stopStream(_venueId: string, messageId: string): Promise<void> {
    const s = this.streams.find((x) => x.messageId === messageId);
    if (s) s.stopped = true;
  }

  // The final rendered text of the most recent stream (what a user would see after it closes).
  lastStreamText(): string {
    return this.streams.at(-1)?.text ?? "";
  }
}
