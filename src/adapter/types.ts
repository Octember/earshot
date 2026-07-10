// SPEC §12 — Surface Adapter Contract. This is the portability boundary: Slack is the reference
// implementation (adapter/slack.ts), but the router and everything above it only depend on this
// interface, so a fake adapter drives every test that doesn't need a live Slack round-trip.
export type VenueKind = "channel" | "dm" | "private_channel";

// A normalized inbound message, already stripped of surface-specific wire format. `ts` is the
// surface's own per-venue-ordered timestamp/id (Slack: message ts); `deliveryId`, if the surface
// provides one distinct from ts (e.g. an envelope/event id), is preferred for dedup.
export interface MessageFile {
  id: string;
  name: string;
  mimetype: string;
  urlPrivate: string; // download with the bot token (needs the files:read scope)
  size: number; // bytes
}

export interface RawMessage {
  venueId: string;
  venueKind: VenueKind;
  principalId: string | null;
  isBot: boolean;
  text: string;
  ts: string;
  threadRootTs: string | null; // null = top-level message
  mentionsBotId: boolean;
  deliveryId?: string;
  files?: MessageFile[]; // attachments (screenshots etc.) — metadata only; content is fetched on demand
}

export interface PostResult {
  messageId: string;
}

// The REQUIRED operations from SPEC §12.1. Real: adapter/slack.ts. Fake: test/fakes/fake-adapter.ts.
export interface SurfaceAdapter {
  start(): Promise<void>;
  stop(): void;
  onMessage(handler: (msg: RawMessage) => void): void;
  postMessage(venueId: string, threadRootTs: string | null, text: string): Promise<PostResult>;
  // Edit an already-posted message (Slack chat.update). Used for streaming: post once, then update
  // as more text arrives. Optional — a surface without edit support just won't stream (the Service
  // posts a single final message instead).
  updateMessage?(venueId: string, messageId: string, text: string): Promise<void>;
  addReaction(venueId: string, messageId: string, emoji: string): Promise<void>;
  // Fetch an attached file's bytes (RawMessage.files[].urlPrivate). Optional — a surface without
  // it simply has no vision; Slack's needs the files:read scope.
  downloadFile?(urlPrivate: string): Promise<Uint8Array>;
  // Read a thread's messages (parent first). Optional — used to ground thread-reply turns in the
  // conversation they're actually standing in. `files` carries attachment metadata so a turn can
  // see a screenshot posted EARLIER in the thread, not just one on the triggering message.
  readThread?(venueId: string, threadTs: string, limit?: number): Promise<{ user: string | null; text: string; ts: string; files?: MessageFile[] }[]>;
  // Build a permalink for a message on this surface (receipts for search hits and citations).
  permalink?(venueId: string, messageId: string): string | undefined;
  // SPEC §12.1 OPTIONAL "typing/status indication". Best-effort: a surface that lacks it, or a
  // venue where it doesn't apply, is a silent no-op — callers must not depend on it. A non-empty
  // `status` shows the shimmering "<App> is thinking…" indicator in the thread; an empty string
  // clears it. `loadingMessages` (Slack: up to 10) rotate while the status is showing.
  setTypingStatus?(venueId: string, threadRootTs: string | null, status: string, loadingMessages?: string[]): Promise<void>;
  // Native surface streaming (Slack chat.startStream/appendStream/stopStream): the real in-channel
  // "…is thinking…" shimmer + live token stream. Requires a thread (thread_ts) and the recipient's
  // id. Optional — a surface without it (or a venue where streaming can't start) falls back to the
  // post-and-edit placeholder. startStream returns the streaming message's id (append/stop target),
  // or null if it couldn't start.
  startStream?(venueId: string, threadRootTs: string, recipientUserId: string): Promise<{ messageId: string } | null>;
  appendStream?(venueId: string, messageId: string, markdownDelta: string): Promise<void>;
  // Live task cards on the streaming message (Slack task_update chunks) — the agentic "working on
  // it" timeline. Same-id updates edit the card in place (in_progress → complete).
  appendTaskUpdate?(venueId: string, messageId: string, task: { id: string; title: string; status: "pending" | "in_progress" | "complete" | "error" }): Promise<void>;
  stopStream?(venueId: string, messageId: string): Promise<void>;
}
