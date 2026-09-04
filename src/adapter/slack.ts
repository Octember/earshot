export type VenueKind = "channel" | "dm" | "private_channel";

export interface MessageFile {
  id: string;
  name: string;
  mimetype: string;
  urlPrivate: string;
  size: number;
}

export interface RawMessage {
  venueId: string;
  venueKind: VenueKind;
  principalId: string | null;
  principalName?: string;
  isBot: boolean;
  text: string;
  ts: string;
  threadRootTs: string | null;
  mentionsBotId: boolean;
  deliveryId?: string;
  files?: MessageFile[];
}

export interface PostResult {
  messageId: string;
}

export interface SlackConfig {
  botToken: string;
  appToken: string;
  botUserId: string;
  connectionCount?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  silentAfterMs?: number;
}

export function reconnectDelay(
  attempt: number,
  opts: { baseMs: number; maxMs: number; rng?: () => number },
): number {
  const ceil = Math.min(opts.baseMs * 2 ** attempt, opts.maxMs);
  const rng = opts.rng ?? Math.random;
  return Math.round(ceil / 2 + rng() * (ceil / 2));
}

const SUBTYPE_ALLOWLIST = new Set([undefined, "bot_message", "file_share", "thread_broadcast"]);

function venueKindOf(channelType: string): VenueKind {
  if (channelType === "im") return "dm";
  if (channelType === "group" || channelType === "mpim") return "private_channel";
  return "channel";
}

export function resolveChannelRef(ref: string): string {
  const s = ref.trim();
  const link = s.match(/^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$/);
  if (link) return link[1]!;
  const bare = s.replace(/^#/, "");
  if (/^[CGD][A-Z0-9]+$/.test(bare)) return bare;
  throw new Error(
    `"${ref}" isn't a channel id or #channel link — mention the channel with # so its id resolves`,
  );
}

export function mentionsByName(text: string, botName: string | null): boolean {
  if (!botName) return false;
  const escaped = botName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`, "i").test(text);
}

export function slackPermalink(workspaceUrl: string, channelId: string, ts: string): string {
  return `${workspaceUrl.replace(/\/$/, "")}/archives/${channelId}/p${ts.replace(".", "")}`;
}

export function displayNameOf(member: Record<string, unknown>): string {
  const profile = (member.profile ?? {}) as Record<string, unknown>;
  for (const v of [profile.display_name, profile.real_name, member.real_name, member.name]) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function messageText(event: Record<string, unknown>): string {
  const direct = typeof event.text === "string" ? event.text : "";
  if (direct.trim()) return direct;
  const attachments = Array.isArray(event.attachments)
    ? (event.attachments as Record<string, unknown>[])
    : [];
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

export function normalizeSlackEvent(
  event: Record<string, unknown>,
  botUserId: string,
  botName: string | null = null,
): RawMessage | null {
  if (event.type !== "message") return null;
  const subtype = typeof event.subtype === "string" ? event.subtype : undefined;
  if (!SUBTYPE_ALLOWLIST.has(subtype)) return null;

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
    ...(files.length > 0 ? { files } : {}),
  };
}

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
  reply_count?: number;
  permalink?: string;
  files?: MessageFile[];
}

interface SlackApiResponse {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

async function callSlackApiGet(
  method: string,
  token: string,
  params: Record<string, string | number>,
): Promise<SlackApiResponse> {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
  const res = await fetch(`https://slack.com/api/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return (await res.json()) as SlackApiResponse;
}

async function callSlackApi(
  method: string,
  token: string,
  body: Record<string, unknown>,
): Promise<SlackApiResponse> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  });
  return (await res.json()) as SlackApiResponse;
}

export class SlackAdapter {
  private handlers: Array<(msg: RawMessage) => void> = [];
  private stopped = false;
  private sockets = new Set<WebSocket>();
  private lastFrameAt = new Map<WebSocket, number>();
  private replaced = new WeakSet<WebSocket>();
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private botName: string | null = null;
  private workspaceUrl: string | null = null;
  private names = new Map<string, string>();
  private nameLookups = new Set<string>();

  constructor(
    private cfg: SlackConfig,
    private onLog: (line: string) => void = () => {},
  ) {}

  onMessage(handler: (msg: RawMessage) => void): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    this.stopped = false;
    void this.cacheAuth();
    void this.loadRoster().catch((e) =>
      this.onLog(`users.list roster prewarm failed (names resolve lazily): ${String(e)}`),
    );
    const count = this.cfg.connectionCount ?? 2;
    const opens: Promise<void>[] = [];
    for (let i = 0; i < count; i++) opens.push(this.openConnection(i));
    await Promise.any(opens);
    const silentAfterMs = this.cfg.silentAfterMs ?? 180_000;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = setInterval(() => this.cycleSilentSockets(silentAfterMs), silentAfterMs / 2);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
    for (const ws of this.sockets) {
      try {
        ws.close();
      } catch {}
    }
    this.sockets.clear();
    this.lastFrameAt.clear();
  }

  private async openConnection(index: number, attempt = 0): Promise<void> {
    if (this.stopped) return;
    let url: string;
    try {
      const opened = await callSlackApi("apps.connections.open", this.cfg.appToken, {});
      if (!opened.ok || typeof opened.url !== "string")
        throw new Error(`apps.connections.open failed: ${opened.error ?? "no url"}`);
      url = opened.url;
    } catch (e) {
      if (this.stopped) return;
      if (attempt === 0) throw e;
      await this.backoff(attempt);
      return this.openConnection(index, attempt + 1);
    }

    const ws = new WebSocket(url);
    ws.addEventListener("message", (ev) => {
      this.lastFrameAt.set(ws, Date.now());
      this.onSocketMessage(ws, ev);
    });
    ws.addEventListener("ping", () => this.lastFrameAt.set(ws, Date.now()));
    ws.addEventListener("close", () => {
      this.sockets.delete(ws);
      this.lastFrameAt.delete(ws);
      if (this.stopped || this.replaced.has(ws)) return;
      this.onLog(`socket ${index} closed unexpectedly, reconnecting`);
      void this.reconnect(index, attempt + 1);
    });
    ws.addEventListener("error", (e) => this.onLog(`socket ${index} error: ${String(e)}`));

    await new Promise<void>((resolve, reject) => {
      ws.addEventListener(
        "open",
        () => {
          this.sockets.add(ws);
          this.lastFrameAt.set(ws, Date.now());
          resolve();
        },
        { once: true },
      );
      ws.addEventListener("error", (e) => reject(e), { once: true });
    });
  }

  private async reconnect(index: number, attempt: number): Promise<void> {
    await this.backoff(attempt);
    await this.openConnection(index, attempt).catch((e) =>
      this.onLog(`socket ${index} reconnect failed: ${String(e)}`),
    );
  }

  private backoff(attempt: number): Promise<void> {
    const ms = reconnectDelay(attempt, {
      baseMs: this.cfg.reconnectBaseMs ?? 1000,
      maxMs: this.cfg.reconnectMaxMs ?? 30_000,
    });
    return new Promise((r) => {
      setTimeout(r, ms);
    });
  }

  private cycleSilentSockets(silentAfterMs: number): void {
    const now = Date.now();
    for (const ws of this.sockets) {
      if (this.replaced.has(ws)) continue;
      const last = this.lastFrameAt.get(ws) ?? now;
      if (now - last < silentAfterMs) continue;
      this.onLog(`socket silent for ${now - last}ms, replacing`);
      this.replaced.add(ws);
      void this.openConnection(this.sockets.size)
        .then(() => (ws as WebSocket & { terminate(): void }).terminate())
        .catch((e) => {
          this.replaced.delete(ws);
          this.onLog(`silent-socket replacement failed, keeping old socket: ${String(e)}`);
        });
    }
  }

  private onSocketMessage(ws: WebSocket, ev: MessageEvent): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    if (msg.type === "disconnect") {
      this.replaced.add(ws);
      void this.openConnection(this.sockets.size)
        .then(() => {
          try {
            ws.close();
          } catch {}
          return null;
        })
        .catch((e) => {
          this.replaced.delete(ws);
          this.onLog(`disconnect replacement failed, keeping old socket: ${String(e)}`);
        });
      return;
    }
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
      } catch {}
    }
  }

  private handleEventsApi(msg: Record<string, unknown>): void {
    const payload = msg.payload as Record<string, unknown> | undefined;
    const event = payload?.event as Record<string, unknown> | undefined;
    if (!event) return;
    if (event.type === "assistant_thread_started") {
      const at = event.assistant_thread as Record<string, unknown> | undefined;
      const channelId = String(at?.channel_id ?? "");
      const threadTs = String(at?.thread_ts ?? "");
      this.onLog(`assistant_thread_started channel=${channelId} thread=${threadTs}`);
      return;
    }
    const normalized = normalizeSlackEvent(event, this.cfg.botUserId, this.botName);
    if (normalized) {
      const named = this.withPrincipalName(normalized);
      for (const handler of this.handlers) handler(named);
    }
  }

  private withPrincipalName(msg: RawMessage): RawMessage {
    if (!msg.principalId) return msg;
    const name = this.names.get(msg.principalId);
    if (name) return { ...msg, principalName: name };
    if (/^[UW]/.test(msg.principalId) && !this.nameLookups.has(msg.principalId)) {
      this.nameLookups.add(msg.principalId);
      void callSlackApiGet("users.info", this.cfg.botToken, { user: msg.principalId })
        .then((r) => {
          const n = r.ok ? displayNameOf((r.user ?? {}) as Record<string, unknown>) : "";
          if (n) this.names.set(msg.principalId!, n);
          return null;
        })
        .catch(() => {});
    }
    return msg;
  }

  private async loadRoster(): Promise<void> {
    let cursor = "";
    for (let page = 0; page < 20; page++) {
      const params: Record<string, string | number> = { limit: 200 };
      if (cursor) params.cursor = cursor;
      const result = await callSlackApiGet("users.list", this.cfg.botToken, params);
      if (!result.ok) throw new Error(String(result.error));
      for (const m of (Array.isArray(result.members) ? result.members : []) as Record<
        string,
        unknown
      >[]) {
        const id = typeof m.id === "string" ? m.id : "";
        const name = displayNameOf(m);
        if (id && name) this.names.set(id, name);
      }
      cursor = String(
        (result.response_metadata as Record<string, unknown> | undefined)?.next_cursor ?? "",
      );
      if (!cursor) return;
    }
  }

  async postMessage(
    venueId: string,
    threadRootTs: string | null,
    text: string,
  ): Promise<PostResult> {
    const body: Record<string, unknown> = { channel: venueId, text };
    if (threadRootTs) body.thread_ts = threadRootTs;
    const result = await callSlackApi("chat.postMessage", this.cfg.botToken, body);
    const ts = typeof result.ts === "string" ? result.ts : null;
    if (!result.ok || !ts)
      throw new Error(`chat.postMessage failed: ${result.error ?? "no ts returned"}`);
    return { messageId: ts };
  }

  async readHistory(channel: string, limit = 20): Promise<HistoryMessage[]> {
    const id = resolveChannelRef(channel);
    const result = await callSlackApiGet("conversations.history", this.cfg.botToken, {
      channel: id,
      limit,
    });
    if (!result.ok)
      throw new Error(
        `conversations.history failed: ${result.error} (is the bot in that channel?)`,
      );
    const msgs = (Array.isArray(result.messages) ? result.messages : []) as Record<
      string,
      unknown
    >[];
    return msgs.map((m) => this.toHistoryMessage(m, id)).reverse();
  }

  async readThread(channel: string, threadTs: string, limit = 50): Promise<HistoryMessage[]> {
    const id = resolveChannelRef(channel);
    const result = await callSlackApiGet("conversations.replies", this.cfg.botToken, {
      channel: id,
      ts: threadTs,
      limit,
    });
    if (!result.ok)
      throw new Error(
        `conversations.replies failed: ${result.error} (is the bot in that channel?)`,
      );
    const msgs = (Array.isArray(result.messages) ? result.messages : []) as Record<
      string,
      unknown
    >[];
    return msgs.map((m) => this.toHistoryMessage(m, id));
  }

  private toHistoryMessage(m: Record<string, unknown>, channelId: string): HistoryMessage {
    const ts = (m.ts as string) ?? "";
    const replyCount = typeof m.reply_count === "number" ? m.reply_count : 0;
    const files = messageFiles(m);
    return {
      user: (m.user as string) ?? (m.bot_id as string) ?? null,
      text: messageText(m),
      ts,
      ...(files.length > 0 ? { files } : {}),
      ...(replyCount > 0 ? { reply_count: replyCount } : {}),
      ...(this.workspaceUrl ? { permalink: slackPermalink(this.workspaceUrl, channelId, ts) } : {}),
    };
  }

  permalink(venueId: string, messageId: string): string | undefined {
    return this.workspaceUrl ? slackPermalink(this.workspaceUrl, venueId, messageId) : undefined;
  }

  async downloadFile(urlPrivate: string): Promise<Uint8Array> {
    const res = await fetch(urlPrivate, {
      headers: { Authorization: `Bearer ${this.cfg.botToken}` },
    });
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    if (type.includes("text/html"))
      throw new Error(
        "file download returned HTML — the Slack app likely lacks the files:read scope",
      );
    return new Uint8Array(await res.arrayBuffer());
  }

  async addReaction(venueId: string, messageId: string, emoji: string): Promise<void> {
    const result = await callSlackApi("reactions.add", this.cfg.botToken, {
      channel: venueId,
      timestamp: messageId,
      name: emoji,
    });
    if (!result.ok && result.error !== "already_reacted")
      throw new Error(`reactions.add failed: ${result.error}`);
  }

  private async cacheAuth(): Promise<void> {
    try {
      const r = await callSlackApi("auth.test", this.cfg.botToken, {});
      if (r.ok && typeof r.user === "string") this.botName = r.user;
      if (r.ok && typeof r.url === "string") this.workspaceUrl = r.url;
    } catch {}
  }

  async setSessionStatus(
    venueId: string,
    threadTs: string,
    status: "processing" | "active" | "suspended" | "closed",
    title?: string,
  ): Promise<void> {
    const result = await callSlackApi("agents.sessions.setStatus", this.cfg.botToken, {
      channel_id: venueId,
      thread_ts: threadTs,
      status,
      ...(title ? { title } : {}),
    });
    if (!result.ok) this.onLog(`agents.sessions.setStatus: ${result.error}`);
  }
}
