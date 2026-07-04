// SPEC §12 — the reference Surface Adapter. Socket Mode over a native WebSocket + fetch (zero new
// dependencies: no @slack/bolt or @slack/web-api — Socket Mode's envelope-ack protocol and the
// handful of REST calls this needs are simple enough not to justify the weight).
import type { MessageFile, PostResult, RawMessage, SurfaceAdapter, VenueKind } from "./types";

export interface SlackConfig {
  botToken: string; // xoxb-...
  appToken: string; // xapp-... (Socket Mode)
  botUserId: string; // this app's own Slack user id — self-filtering + mention detection
  // SPEC §12.3 / M9: Slack load-balances events across an app's open Socket Mode connections and
  // delivers each event to exactly one — ≥2 connections means a reconnect never leaves a gap.
  connectionCount?: number; // default 2
  reconnectBaseMs?: number; // default 1000
  reconnectMaxMs?: number; // default 30000
}

// M9: exponential backoff with equal jitter for reconnect attempts — grows base·2^attempt capped
// at maxMs, then jitters in [ceil/2, ceil] so a fleet of connections doesn't reconnect in lockstep
// and hammer Slack during an outage. `rng` is injectable for deterministic tests.
export function reconnectDelay(attempt: number, opts: { baseMs: number; maxMs: number; rng?: () => number }): number {
  const ceil = Math.min(opts.baseMs * 2 ** attempt, opts.maxMs);
  const rng = opts.rng ?? Math.random;
  return Math.round(ceil / 2 + rng() * (ceil / 2));
}

const SUBTYPE_ALLOWLIST = new Set([undefined, "bot_message"]);

function venueKindOf(channelType: string): VenueKind {
  if (channelType === "im") return "dm";
  if (channelType === "group" || channelType === "mpim") return "private_channel";
  return "channel";
}

// Pure normalization: Slack's raw `event` payload (from an events_api envelope) -> RawMessage, or
// null if this event isn't a message earshot conversation cares about (reactions, joins, edits, ...).
//
// Deliberately only handles `message` events, not `app_mention` — mentions are detected from text
// (`<@botUserId>`) instead. Slack sends BOTH event types for the same mention when a bot has
// `app_mentions:read`; subscribing to both would double-deliver every mention. The Slack app's
// Event Subscriptions must be configured for `message.channels`/`message.groups`/`message.im`/
// `message.mpim` only.
// Resolve a channel reference to a Slack channel ID. Accepts a bare id (C…/G…/D…), a `#id`, or a
// channel link `<#C…|name>` (what `#channel` in a user's message becomes in raw text). A bare
// human name can't be resolved without the channels:read scope, so it's rejected with a hint.
export function resolveChannelRef(ref: string): string {
  const s = ref.trim();
  const link = s.match(/^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (link) return link[1]!;
  const bare = s.replace(/^#/, "");
  if (/^[CGD][A-Z0-9]+$/.test(bare)) return bare;
  throw new Error(`"${ref}" isn't a channel id or #channel link — mention the channel with # so its id resolves`);
}

// Passive listening: saying the bot's NAME in plain text ("Marvin if u see this…") addresses it
// just like <@mention> — whole word, case-insensitive, so a name-prefix ("marvinX") does not match.
export function mentionsByName(text: string, botName: string | null): boolean {
  if (!botName) return false;
  const escaped = botName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`, "i").test(text);
}

// Slack message permalink: workspace url + /archives/<channel>/p<ts with the dot stripped>.
export function slackPermalink(workspaceUrl: string, channelId: string, ts: string): string {
  return `${workspaceUrl.replace(/\/$/, "")}/archives/${channelId}/p${ts.replace(".", "")}`;
}

// A message's readable content. Integrations (Datadog, PagerDuty, ...) often post with an EMPTY
// top-level text and the entire alert in legacy attachments — without draining those, an alert
// arrives as a blank line and ambient has nothing to evaluate.
function messageText(event: Record<string, unknown>): string {
  const direct = typeof event.text === "string" ? event.text : "";
  if (direct.trim()) return direct;
  const attachments = Array.isArray(event.attachments) ? (event.attachments as Record<string, unknown>[]) : [];
  const parts: string[] = [];
  for (const a of attachments) {
    const title = typeof a.title === "string" ? a.title.trim() : "";
    const body = typeof a.text === "string" ? a.text.trim() : "";
    const fallback = typeof a.fallback === "string" ? a.fallback.trim() : "";
    const composed = [title, body].filter(Boolean).join("\n");
    if (composed) parts.push(composed);
    else if (fallback) parts.push(fallback);
  }
  return parts.join("\n\n");
}

export function normalizeSlackEvent(event: Record<string, unknown>, botUserId: string, botName: string | null = null): RawMessage | null {
  if (event.type !== "message") return null;
  const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
  if (!SUBTYPE_ALLOWLIST.has(subtype)) return null; // §12.2: edits/joins/etc. have no retroactive effect

  const ts = String(event.ts ?? "");
  const channel = String(event.channel ?? "");
  const text = messageText(event);
  const channelType = typeof event.channel_type === "string" ? event.channel_type : "channel";
  const threadTs = typeof event.thread_ts === "string" ? event.thread_ts : null;
  const botId = typeof event.bot_id === "string" ? event.bot_id : null;
  const user = typeof event.user === "string" ? event.user : null;
  const isBot = botId !== null || subtype === "bot_message";
  const files = messageFiles(event);

  return {
    venueId: channel,
    venueKind: venueKindOf(channelType),
    principalId: user ?? botId,
    isBot,
    text,
    ts,
    threadRootTs: threadTs && threadTs !== ts ? threadTs : null,
    mentionsBotId: text.includes(`<@${botUserId}>`) || mentionsByName(text, botName),
    deliveryId: ts,
    ...(files.length ? { files } : {}),
  };
}

// Attached files (screenshots etc.) — metadata only; the content is fetched on demand with the
// bot token. Slack's `files` array carries url_private, which requires the files:read scope.
function messageFiles(event: Record<string, unknown>): MessageFile[] {
  const raw = Array.isArray(event.files) ? (event.files as Record<string, unknown>[]) : [];
  const out: MessageFile[] = [];
  for (const f of raw) {
    const id = typeof f.id === "string" ? f.id : "";
    const urlPrivate = typeof f.url_private === "string" ? f.url_private : "";
    if (!id || !urlPrivate) continue;
    out.push({
      id,
      name: typeof f.name === "string" ? f.name : id,
      mimetype: typeof f.mimetype === "string" ? f.mimetype : "",
      urlPrivate,
      size: typeof f.size === "number" ? f.size : 0,
    });
  }
  return out;
}

export interface HistoryMessage {
  user: string | null;
  text: string;
  ts: string;
  reply_count?: number; // present when the message roots a thread — pull it with read_thread
  permalink?: string;
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function callSlackApi(method: string, token: string, body: Record<string, unknown>): Promise<SlackApiResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  });
  return (await res.json()) as SlackApiResponse;
}

export class SlackAdapter implements SurfaceAdapter {
  private handlers: Array<(msg: RawMessage) => void> = [];
  private stopped = false;
  private sockets = new Set<WebSocket>(); // the live connection pool
  private teamId: string | null = null; // cached from auth.test — required by chat.startStream
  private botName: string | null = null; // cached from auth.test — plain-name passive listening
  private workspaceUrl: string | null = null; // cached from auth.test — permalink construction

  constructor(
    private cfg: SlackConfig,
    private onLog: (line: string) => void = () => {},
  ) {}

  onMessage(handler: (msg: RawMessage) => void): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    this.stopped = false;
    // Cache the workspace team id once — chat.startStream requires recipient_team_id. Best-effort:
    // streaming just falls back to post-and-edit if this is unavailable.
    void callSlackApi("auth.test", this.cfg.botToken, {})
      .then((r) => {
        if (r.ok && typeof r.team_id === "string") this.teamId = r.team_id;
        if (r.ok && typeof r.user === "string") this.botName = r.user; // e.g. "marvin"
        if (r.ok && typeof r.url === "string") this.workspaceUrl = r.url; // e.g. "https://acme.slack.com/"
      })
      .catch(() => {});
    const count = this.cfg.connectionCount ?? 2;
    // Open all connections; resolve once the first is live so the service can proceed — the rest
    // finish opening in the background. An event racing two sockets is harmless (the events UNIQUE
    // constraint dedups it in the router).
    const opens: Promise<void>[] = [];
    for (let i = 0; i < count; i++) opens.push(this.openConnection(i));
    await Promise.any(opens);
  }

  stop(): void {
    this.stopped = true;
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {
        // already gone
      }
    }
    this.sockets.clear();
  }

  private async openConnection(index: number, attempt = 0): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      const opened = await callSlackApi("apps.connections.open", this.cfg.appToken, {});
      if (!opened.ok || typeof opened.url !== "string") throw new Error(`apps.connections.open failed: ${opened.error ?? "no url"}`);
      url = opened.url;
    } catch (e) {
      if (this.stopped) return;
      // The initial open on the FIRST attempt is fatal (bad token, no network) — surface it so the
      // operator sees a misconfig at boot rather than a silent retry loop.
      if (attempt === 0) throw e;
      await this.backoff(attempt);
      return this.openConnection(index, attempt + 1);
    }

    const ws = new WebSocket(url);
    let replaced = false; // set when a `disconnect` frame prompts a graceful replacement
    ws.addEventListener("message", (ev) => this.onSocketMessage(ws, ev, () => (replaced = true)));
    ws.addEventListener("close", () => {
      this.sockets.delete(ws);
      if (this.stopped || replaced) return; // clean shutdown / already replaced — don't reconnect
      this.onLog(`socket ${index} closed unexpectedly, reconnecting`);
      void this.reconnect(index, attempt + 1);
    });
    ws.addEventListener("error", (e) => this.onLog(`socket ${index} error: ${String(e)}`));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => {
        this.sockets.add(ws);
        resolve();
      }, { once: true });
      ws.addEventListener("error", (e) => reject(e), { once: true });
    });
  }

  private async reconnect(index: number, attempt: number): Promise<void> {
    await this.backoff(attempt);
    await this.openConnection(index, attempt).catch((e) => this.onLog(`socket ${index} reconnect failed: ${String(e)}`));
  }

  private backoff(attempt: number): Promise<void> {
    const ms = reconnectDelay(attempt, { baseMs: this.cfg.reconnectBaseMs ?? 1000, maxMs: this.cfg.reconnectMaxMs ?? 30_000 });
    return new Promise((r) => setTimeout(r, ms));
  }

  private onSocketMessage(ws: WebSocket, ev: MessageEvent, markReplaced: () => void): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    // SPEC §12.3 / M9: Slack sends a `disconnect` warning before killing a socket for maintenance
    // (reason: refresh_requested). Open the replacement FIRST, then close this one — zero-gap
    // failover (the old close-then-reconnect had a brief window with one fewer connection).
    if (msg.type === "disconnect") {
      markReplaced();
      void this.openConnection(this.sockets.size)
        .then(() => {
          try {
            ws.close();
          } catch {
            // already gone
          }
        })
        .catch((e) => this.onLog(`disconnect replacement failed, keeping old socket: ${String(e)}`));
      return;
    }
    // Ack AFTER handling, not before (§12.2 at-least-once): an envelope acked up front is gone
    // forever if the handler chain fails or the process dies mid-event; left unacked, Slack
    // redelivers it and the router's dedup key makes the retry a safe no-op. Handling is
    // synchronous (route + persist + enqueue), so the ack delay is microseconds.
    if (msg.type === "events_api") {
      try {
        this.handleEventsApi(msg);
      } catch (e) {
        this.onLog(`event handler failed — leaving envelope unacked for redelivery: ${String(e)}`);
        return;
      }
    }
    if (typeof msg.envelope_id === "string") {
      try {
        ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
      } catch {
        // socket closing — the event will redeliver on another connection (at-least-once)
      }
    }
  }

  private handleEventsApi(msg: Record<string, unknown>): void {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const event = payload?.event as Record<string, unknown> | undefined;
    if (!event) return;
    // First-class Assistant onboarding: when a user opens the assistant pane, Slack sends
    // `assistant_thread_started`. Greet with suggested-prompt chips + a title so the pane isn't a
    // blank box. Self-contained (no ledger) — best-effort, failures are logged not thrown.
    if (event.type === "assistant_thread_started") {
      const at = event.assistant_thread as Record<string, unknown> | undefined;
      const channelId = String(at?.channel_id ?? "");
      const threadTs = String(at?.thread_ts ?? "");
      this.onLog(`assistant_thread_started channel=${channelId} thread=${threadTs}`);
      if (channelId && threadTs) {
        const g = assistantGreeting();
        void this.setSuggestedPrompts(channelId, threadTs, g.prompts, g.title).catch((e) => this.onLog(`assistant greet: ${String(e)}`));
      }
      return;
    }
    const normalized = normalizeSlackEvent(event, this.cfg.botUserId, this.botName);
    if (normalized) for (const handler of this.handlers) handler(normalized);
  }

  async postMessage(venueId: string, threadRootTs: string | null, text: string): Promise<PostResult> {
    const body: Record<string, unknown> = { channel: venueId, text };
    if (threadRootTs) body.thread_ts = threadRootTs;
    const result = await callSlackApi("chat.postMessage", this.cfg.botToken, body);
    const ts = typeof result.ts === "string" ? result.ts : null;
    if (!result.ok || !ts) throw new Error(`chat.postMessage failed: ${result.error ?? "no ts returned"}`);
    return { messageId: ts };
  }

  async updateMessage(venueId: string, messageId: string, text: string): Promise<void> {
    const result = await callSlackApi("chat.update", this.cfg.botToken, { channel: venueId, ts: messageId, text });
    if (!result.ok) throw new Error(`chat.update failed: ${result.error}`);
  }

  // Read recent messages from a channel (the read_channel tool). Accepts a channel ID (C…/G…), a
  // Slack channel link `<#C…|name>` (what a user's `#channel` mention becomes in raw text — so no
  // channels:read scope is needed to resolve it), or `#name`/`name` only if it happens to be an id.
  // Requires the bot to be a member of the channel + a *:history scope.
  async readHistory(channel: string, limit = 20): Promise<HistoryMessage[]> {
    const id = resolveChannelRef(channel);
    const result = await callSlackApi("conversations.history", this.cfg.botToken, { channel: id, limit });
    if (!result.ok) throw new Error(`conversations.history failed: ${result.error} (is the bot in that channel?)`);
    const msgs = (Array.isArray(result.messages) ? result.messages : []) as Record<string, unknown>[];
    return msgs.map((m) => this.toHistoryMessage(m, id)).reverse(); // chronological
  }

  // Read a thread's replies (the read_thread tool). conversations.history only returns channel-root
  // messages — replies live behind conversations.replies, keyed by the root message's ts.
  async readThread(channel: string, threadTs: string, limit = 50): Promise<HistoryMessage[]> {
    const id = resolveChannelRef(channel);
    const result = await callSlackApi("conversations.replies", this.cfg.botToken, { channel: id, ts: threadTs, limit });
    if (!result.ok) throw new Error(`conversations.replies failed: ${result.error} (is the bot in that channel?)`);
    const msgs = (Array.isArray(result.messages) ? result.messages : []) as Record<string, unknown>[];
    return msgs.map((m) => this.toHistoryMessage(m, id)); // replies arrive oldest-first already
  }

  private toHistoryMessage(m: Record<string, unknown>, channelId: string): HistoryMessage {
    const ts = (m.ts as string) ?? "";
    const replyCount = typeof m.reply_count === "number" ? m.reply_count : 0;
    return {
      user: (m.user as string) ?? (m.bot_id as string) ?? null,
      text: (m.text as string) ?? "",
      ts,
      // A message with replies is a thread root — surface the count so the agent knows there's a
      // conversation behind it to pull with read_thread.
      ...(replyCount > 0 ? { reply_count: replyCount } : {}),
      // Receipts: a permalink per message so the agent can CITE what it read — a linked claim
      // is evidence, an unlinked one is vibes.
      permalink: this.workspaceUrl ? slackPermalink(this.workspaceUrl, channelId, ts) : undefined,
    };
  }

  // Fetch an attached file's bytes (bot token auth). Slack answers a missing files:read scope
  // with an HTML login page rather than an API error — detect and name it.
  async downloadFile(urlPrivate: string): Promise<Uint8Array> {
    const res = await fetch(urlPrivate, { headers: { Authorization: `Bearer ${this.cfg.botToken}` } });
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html")) throw new Error("file download returned HTML — the Slack app likely lacks the files:read scope");
    return new Uint8Array(await res.arrayBuffer());
  }

  async addReaction(venueId: string, messageId: string, emoji: string): Promise<void> {
    const result = await callSlackApi("reactions.add", this.cfg.botToken, { channel: venueId, timestamp: messageId, name: emoji });
    if (!result.ok && result.error !== "already_reacted") throw new Error(`reactions.add failed: ${result.error}`);
  }

  // Slack's native "Marvin is typing…" status via the Assistants API (assistant.threads.setStatus).
  // Best-effort by contract (§12.1 OPTIONAL) and by nature: it only applies in the app's Assistant
  // threads and needs the `assistant:write` scope + the "Agents & AI Apps" feature enabled, so a
  // failure (wrong venue kind, missing scope) is swallowed, not thrown — the reply still lands.
  // Native Slack streaming (chat.startStream) — the real in-channel "…is thinking…" shimmer + live
  // token stream. Requires a thread_ts + recipient user/team. Returns the streaming message id to
  // append/stop against, or null if it couldn't start (caller falls back to post-and-edit).
  async startStream(venueId: string, threadRootTs: string, recipientUserId: string): Promise<{ messageId: string } | null> {
    const body: Record<string, unknown> = {
      channel: venueId,
      thread_ts: threadRootTs,
      recipient_user_id: recipientUserId,
      // "plan": task_update chunks render as ONE compact grouped checklist that ticks in place —
      // not the default timeline's stack of separate full-width cards.
      task_display_mode: "plan",
    };
    if (this.teamId) body.recipient_team_id = this.teamId;
    const result = await callSlackApi("chat.startStream", this.cfg.botToken, body);
    if (!result.ok || typeof result.ts !== "string") {
      this.onLog(`chat.startStream: ${result.error ?? "no ts"}`);
      return null;
    }
    return { messageId: result.ts };
  }

  // All appends use the `chunks` form: once any chunk-style append (e.g. a task card) has been
  // sent, plain markdown_text appends are rejected with streaming_mode_mismatch — so we never mix.
  async appendStream(venueId: string, messageId: string, markdownDelta: string): Promise<void> {
    const result = await callSlackApi("chat.appendStream", this.cfg.botToken, {
      channel: venueId,
      ts: messageId,
      chunks: [{ type: "markdown_text", text: markdownDelta }],
    });
    if (!result.ok) throw new Error(`chat.appendStream failed: ${result.error}`);
  }

  // The agentic timeline: task_update chunks render as live task cards on the streaming message
  // ("Reading #bug-reports…" → ✓). Same-id updates edit the card in place.
  async appendTaskUpdate(venueId: string, messageId: string, task: { id: string; title: string; status: "pending" | "in_progress" | "complete" | "error" }): Promise<void> {
    const result = await callSlackApi("chat.appendStream", this.cfg.botToken, {
      channel: venueId,
      ts: messageId,
      chunks: [{ type: "task_update", id: task.id, title: task.title.slice(0, 250), status: task.status }],
    });
    if (!result.ok) throw new Error(`chat.appendStream task_update failed: ${result.error}`);
  }

  async stopStream(venueId: string, messageId: string): Promise<void> {
    const result = await callSlackApi("chat.stopStream", this.cfg.botToken, { channel: venueId, ts: messageId });
    if (!result.ok) this.onLog(`chat.stopStream: ${result.error}`);
  }

  async setTypingStatus(venueId: string, threadRootTs: string | null, status: string, loadingMessages?: string[]): Promise<void> {
    const body: Record<string, unknown> = {
      channel_id: venueId,
      thread_ts: threadRootTs ?? "",
      status, // empty string clears the indicator
    };
    if (loadingMessages?.length) body.loading_messages = loadingMessages.slice(0, 10);
    const result = await callSlackApi("assistant.threads.setStatus", this.cfg.botToken, body);
    if (!result.ok) this.onLog(`assistant.threads.setStatus: ${result.error}`);
  }

  // The clickable starter chips shown in a fresh Assistant pane (assistant.threads.setSuggestedPrompts).
  // Requires the `assistant:write` scope + the Agent/Assistant feature enabled on the Slack app.
  async setSuggestedPrompts(
    channelId: string,
    threadTs: string,
    prompts: { title: string; message: string }[],
    title?: string,
  ): Promise<void> {
    const result = await callSlackApi("assistant.threads.setSuggestedPrompts", this.cfg.botToken, {
      channel_id: channelId,
      thread_ts: threadTs,
      prompts,
      ...(title ? { title } : {}),
    });
    if (!result.ok) this.onLog(`assistant.threads.setSuggestedPrompts: ${result.error}`);
  }
}

// The default greeting shown when a user opens the Assistant pane. Pure so it's unit-testable and
// easy to tune without touching the socket plumbing.
export function assistantGreeting(): { title: string; prompts: { title: string; message: string }[] } {
  return {
    title: "How can I help?",
    prompts: [
      { title: "Summarize a channel", message: "Summarize the recent activity in #" },
      { title: "Delegate some work", message: "Look into  and report back when you have something." },
      { title: "What can you do?", message: "What can you help me with?" },
    ],
  };
}
