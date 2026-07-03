import type { PostResult, RawMessage, SurfaceAdapter } from "../../src/adapter/types";

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

  async setTypingStatus(venueId: string, threadRootTs: string | null, status: string): Promise<void> {
    this.statuses.push({ venueId, threadRootTs, status });
  }
}
