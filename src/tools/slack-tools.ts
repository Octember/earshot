import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { ToolRegistry } from "./catalog-types";

const ReadChannel = z.object({ channel: z.string(), limit: z.number().optional() });
const ReadThread = z.object({
  channel: z.string(),
  thread_ts: z.string(),
  limit: z.number().optional(),
});
const Download = z.object({ url: z.string(), name: z.string().optional() });
const Upload = z.object({
  path: z.string(),
  channel: z.string(),
  thread_ts: z.string().optional(),
  title: z.string().optional(),
});
const Search = z.object({ query: z.string(), count: z.number().optional() });
const Emoji = z.object({ name: z.string(), url: z.string() });

function pick(
  messages:
    | {
        user?: string;
        bot_id?: string;
        text?: string;
        ts?: string;
        reply_count?: number;
        files?: unknown[];
      }[]
    | undefined,
) {
  return (messages ?? []).map(({ user, bot_id, text, ts, reply_count, files }) => ({
    user: user ?? bot_id,
    text,
    ts,
    reply_count,
    files,
  }));
}

export function slackRegistry(deps: {
  web: WebClient;
  adminToken?: string | undefined;
  workspace: string;
}): ToolRegistry {
  const admin = deps.adminToken ? new WebClient(deps.adminToken) : null;
  const needsAdmin = {
    success: false,
    output: "not wired up here — an admin credential is missing",
  };
  return {
    name: "slack",
    skill:
      "Read beyond the thread in front of you, move files in and out of your workspace, and search the workspace.",
    tools: {
      read_channel: {
        spec: {
          name: "read_channel",
          description:
            "Recent channel-root messages, oldest first; one with reply_count > 0 roots a thread (read_thread). Input: { channel, limit? }.",
          inputSchema: z.toJSONSchema(ReadChannel),
        },
        run: async (raw) => {
          const { channel, limit } = ReadChannel.parse(raw);
          const { messages } = await deps.web.conversations.history({
            channel,
            limit: Math.min(limit ?? 20, 100),
          });
          return { success: true, output: JSON.stringify(pick(messages).toReversed()) };
        },
      },
      read_thread: {
        spec: {
          name: "read_thread",
          description: "A thread's messages. Input: { channel, thread_ts, limit? }.",
          inputSchema: z.toJSONSchema(ReadThread),
        },
        run: async (raw) => {
          const { channel, thread_ts, limit } = ReadThread.parse(raw);
          const { messages } = await deps.web.conversations.replies({
            channel,
            ts: thread_ts,
            limit: Math.min(limit ?? 50, 200),
          });
          return { success: true, output: JSON.stringify(pick(messages)) };
        },
      },
      download_file: {
        spec: {
          name: "download_file",
          description:
            "Save an attachment (its url_private) into your workspace at full resolution. Input: { url, name? }. Returns the absolute path.",
          inputSchema: z.toJSONSchema(Download),
        },
        run: async (raw) => {
          const { url, name } = Download.parse(raw);
          if (new URL(url).host !== "files.slack.com")
            return { success: false, output: "only files.slack.com url_private links" };
          const res = await fetch(url, { headers: { Authorization: `Bearer ${deps.web.token}` } });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const dir = resolve(deps.workspace, "files");
          mkdirSync(dir, { recursive: true });
          const path = resolve(dir, basename(name ?? new URL(url).pathname));
          await Bun.write(path, await res.arrayBuffer());
          return { success: true, output: path };
        },
      },
      upload_file: {
        spec: {
          name: "upload_file",
          description:
            "Post a file from your workspace into a conversation. Input: { path, channel, thread_ts?, title? } — thread_ts absent posts top-level.",
          inputSchema: z.toJSONSchema(Upload),
        },
        run: async (raw) => {
          const { path, channel, thread_ts, title } = Upload.parse(raw);
          const filename = basename(path);
          const upload = {
            file: Buffer.from(await Bun.file(resolve(deps.workspace, path)).arrayBuffer()),
            filename,
            title: title ?? filename,
            channel_id: channel,
          };
          await deps.web.files.uploadV2(thread_ts ? { ...upload, thread_ts } : upload);
          return { success: true, output: `sent ${filename}` };
        },
      },
      search: {
        spec: {
          name: "search",
          description:
            "Slack search, same syntax as the search box (quotes, in:#channel, from:@user, before:/after:). Hits carry a permalink — cite it. Input: { query, count? }.",
          inputSchema: z.toJSONSchema(Search),
        },
        run: async (raw) => {
          const { query, count } = Search.parse(raw);
          if (!admin) return needsAdmin;
          const result = await admin.search.messages({ query, count: Math.min(count ?? 10, 50) });
          const matches = (result.messages?.matches ?? []).map((m) => ({
            channel: m.channel?.id,
            ts: m.ts,
            user: m.user,
            username: m.username,
            text: m.text?.slice(0, 700),
            permalink: m.permalink,
          }));
          return { success: true, output: JSON.stringify(matches) };
        },
      },
      emoji_set: {
        spec: {
          name: "emoji_set",
          description: "Create or replace a custom emoji from an image URL. Input: { name, url }.",
          inputSchema: z.toJSONSchema(Emoji),
        },
        run: async (raw) => {
          const { name: rawName, url } = Emoji.parse(raw);
          if (!admin) return needsAdmin;
          const name = rawName.replaceAll(":", "").trim().toLowerCase();
          await admin.admin.emoji.remove({ name }).catch(() => {});
          await admin.admin.emoji.add({ name, url });
          return { success: true, output: `:${name}: is live` };
        },
      },
    },
  };
}
