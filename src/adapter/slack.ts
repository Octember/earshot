import { SocketModeClient } from "@slack/socket-mode";
import { WebAPIPlatformError, WebClient } from "@slack/web-api";
import type { MessageEvent } from "@slack/types";
import type { MessageElement } from "@slack/web-api/dist/types/response/ConversationsHistoryResponse";
import type { Member } from "@slack/web-api/dist/types/response/UsersListResponse";

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
  files?: MessageFile[];
}

export interface HistoryMessage {
  user: string | null;
  text: string;
  ts: string;
  reply_count?: number;
  permalink?: string;
  files?: MessageFile[];
}

type SlackFile = {
  id?: string;
  name?: string | null;
  mimetype?: string;
  url_private?: string;
  size?: number;
};
type Attachment = { title?: string; text?: string; fallback?: string };

const HEARD_SUBTYPES = new Set<string | undefined>([
  undefined,
  "bot_message",
  "file_share",
  "thread_broadcast",
]);

function venueKindOf(channelType: string): VenueKind {
  if (channelType === "im") return "dm";
  if (channelType === "group" || channelType === "mpim") return "private_channel";
  return "channel";
}

export function resolveChannelRef(ref: string): string {
  const s = ref.trim();
  const link = /^<#([CGD][A-Z0-9]+)(?:\|[^>]*)?>$/.exec(s);
  if (link) return link[1]!;
  const bare = s.replace(/^#/, "");
  if (/^[CGD][A-Z0-9]+$/.test(bare)) return bare;
  throw new Error(
    `"${ref}" isn't a channel id or #channel link — mention the channel with # so its id resolves`,
  );
}

function mentionsByName(text: string, botName: string | null): boolean {
  if (!botName) return false;
  const escaped = botName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\w])${escaped}($|[^\\w])`, "i").test(text);
}

function permalinkFor(workspaceUrl: string, channelId: string, ts: string): string {
  return `${workspaceUrl.replace(/\/$/, "")}/archives/${channelId}/p${ts.replace(".", "")}`;
}

function displayNameOf(member: Member): string {
  for (const v of [
    member.profile?.display_name,
    member.profile?.real_name,
    member.real_name,
    member.name,
  ])
    if (v?.trim()) return v.trim();
  return "";
}

function messageText(text: string | undefined, attachments: Attachment[] | undefined): string {
  if (text?.trim()) return text;
  return (attachments ?? [])
    .map((a) => [a.title?.trim(), a.text?.trim()].filter(Boolean).join("\n") || a.fallback?.trim())
    .filter(Boolean)
    .join("\n\n");
}

function messageFiles(files: readonly SlackFile[] | undefined): MessageFile[] {
  return (files ?? []).flatMap((f) =>
    f.id && f.url_private
      ? [
          {
            id: f.id,
            name: f.name ?? f.id,
            mimetype: f.mimetype ?? "",
            urlPrivate: f.url_private,
            size: f.size ?? 0,
          },
        ]
      : [],
  );
}

export function normalizeSlackEvent(
  event: MessageEvent,
  botUserId: string,
  botName: string | null,
): RawMessage | null {
  if (!HEARD_SUBTYPES.has(event.subtype)) return null;
  const files = "files" in event ? messageFiles(event.files) : [];
  const text = messageText(
    "text" in event ? event.text : undefined,
    "attachments" in event ? event.attachments : undefined,
  );
  const threadTs = "thread_ts" in event ? event.thread_ts : undefined;
  const botId = "bot_id" in event ? event.bot_id : undefined;
  const user = "user" in event ? event.user : undefined;
  return {
    venueId: event.channel,
    venueKind: venueKindOf(event.channel_type),
    principalId: user ?? botId ?? null,
    isBot: botId !== undefined || event.subtype === "bot_message",
    text,
    ts: event.ts,
    threadRootTs: threadTs && threadTs !== event.ts ? threadTs : null,
    mentionsBotId: text.includes(`<@${botUserId}>`) || mentionsByName(text, botName),
    ...(files.length > 0 ? { files } : {}),
  };
}

function platformError(error: unknown): string | null {
  return error instanceof WebAPIPlatformError ? error.data.error : null;
}

export class SlackAdapter {
  readonly web: WebClient;
  private readonly socket: SocketModeClient;
  private readonly handlers: Array<(msg: RawMessage) => void> = [];
  private botName: string | null = null;
  private workspaceUrl: string | null = null;
  private readonly names = new Map<string, string>();
  private readonly nameLookups = new Set<string>();

  constructor(
    private readonly cfg: { botToken: string; appToken: string; botUserId: string },
    private readonly onLog: (line: string) => void,
  ) {
    this.web = new WebClient(cfg.botToken);
    this.socket = new SocketModeClient({ appToken: cfg.appToken });
    this.socket.on(
      "message",
      ({ event, ack }: { event: MessageEvent; ack: () => Promise<void> }) => {
        void ack();
        const normalized = normalizeSlackEvent(event, cfg.botUserId, this.botName);
        if (!normalized) return;
        const named = this.withPrincipalName(normalized);
        for (const handler of this.handlers) handler(named);
      },
    );
    this.socket.on("error", (error: unknown) => {
      this.onLog(`socket: ${String(error)}`);
    });
  }

  onMessage(handler: (msg: RawMessage) => void): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    const auth = await this.web.auth.test();
    this.botName = auth.user ?? null;
    this.workspaceUrl = auth.url ?? null;
    void this.loadRoster().catch((error: unknown) => {
      this.onLog(`users.list failed (names resolve lazily): ${String(error)}`);
    });
    await this.socket.start();
  }

  stop(): void {
    void this.socket.disconnect();
  }

  private withPrincipalName(msg: RawMessage): RawMessage {
    if (!msg.principalId) return msg;
    const name = this.names.get(msg.principalId);
    if (name) return { ...msg, principalName: name };
    const id = msg.principalId;
    if (/^[UW]/.test(id) && !this.nameLookups.has(id)) {
      this.nameLookups.add(id);
      void this.web.users.info({ user: id }).then(
        (r) => {
          const n = r.user ? displayNameOf(r.user) : "";
          if (n) this.names.set(id, n);
          return null;
        },
        () => {},
      );
    }
    return msg;
  }

  private async loadRoster(): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.web.users.list({ limit: 200, ...(cursor ? { cursor } : {}) });
      for (const member of page.members ?? []) {
        const name = displayNameOf(member);
        if (member.id && name) this.names.set(member.id, name);
      }
      const next = page.response_metadata?.next_cursor;
      cursor = next === "" ? undefined : next;
    } while (cursor);
  }

  async postMessage(
    venueId: string,
    threadRootTs: string | null,
    text: string,
  ): Promise<{ messageId: string }> {
    const result = await this.web.chat.postMessage({
      channel: venueId,
      text,
      ...(threadRootTs ? { thread_ts: threadRootTs } : {}),
    });
    if (!result.ts) throw new Error("chat.postMessage returned no ts");
    return { messageId: result.ts };
  }

  async readHistory(channel: string, limit = 20): Promise<HistoryMessage[]> {
    const id = resolveChannelRef(channel);
    const result = await this.web.conversations.history({ channel: id, limit });
    return (result.messages ?? []).map((m) => this.toHistoryMessage(m, id)).toReversed();
  }

  async readThread(channel: string, threadTs: string, limit = 50): Promise<HistoryMessage[]> {
    const id = resolveChannelRef(channel);
    const result = await this.web.conversations.replies({ channel: id, ts: threadTs, limit });
    return (result.messages ?? []).map((m) => this.toHistoryMessage(m, id));
  }

  private toHistoryMessage(m: MessageElement, channelId: string): HistoryMessage {
    const ts = m.ts ?? "";
    const files = messageFiles(m.files);
    return {
      user: m.user ?? m.bot_id ?? null,
      text: messageText(m.text, m.attachments),
      ts,
      ...(files.length > 0 ? { files } : {}),
      ...(m.reply_count ? { reply_count: m.reply_count } : {}),
      ...(this.workspaceUrl ? { permalink: permalinkFor(this.workspaceUrl, channelId, ts) } : {}),
    };
  }

  permalink(venueId: string, messageId: string): string | undefined {
    return this.workspaceUrl ? permalinkFor(this.workspaceUrl, venueId, messageId) : undefined;
  }

  async downloadFile(urlPrivate: string): Promise<Uint8Array> {
    const res = await fetch(urlPrivate, {
      headers: { Authorization: `Bearer ${this.cfg.botToken}` },
    });
    if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
    if ((res.headers.get("content-type") ?? "").includes("text/html"))
      throw new Error(
        "file download returned HTML — the Slack app likely lacks the files:read scope",
      );
    return new Uint8Array(await res.arrayBuffer());
  }

  async addReaction(venueId: string, messageId: string, emoji: string): Promise<void> {
    try {
      await this.web.reactions.add({ channel: venueId, timestamp: messageId, name: emoji });
    } catch (error) {
      if (platformError(error) !== "already_reacted") throw error;
    }
  }

  async setSessionStatus(
    venueId: string,
    threadTs: string,
    status: "processing" | "active" | "suspended" | "closed",
    title?: string,
  ): Promise<void> {
    await this.web.agents.sessions.setStatus({
      channel_id: venueId,
      thread_ts: threadTs,
      status,
      ...(title ? { title } : {}),
    });
  }
}
