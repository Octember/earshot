import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import { defineTool } from "../schemas/tool";
import type { ToolRegistry } from "./catalog-types";

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
      read_channel: defineTool(
        "read_channel",
        "Recent channel-root messages, oldest first; one with reply_count > 0 roots a thread (read_thread). Input: { channel, limit? }.",
        z.object({ channel: z.string(), limit: z.number().optional() }),
        async ({ channel, limit }) => {
          const { messages } = await deps.web.conversations.history({
            channel,
            limit: Math.min(limit ?? 20, 100),
          });
          return { success: true, output: JSON.stringify(pick(messages).toReversed()) };
        },
      ),
      read_thread: defineTool(
        "read_thread",
        "A thread's messages. Input: { channel, thread_ts, limit? }.",
        z.object({ channel: z.string(), thread_ts: z.string(), limit: z.number().optional() }),
        async ({ channel, thread_ts, limit }) => {
          const { messages } = await deps.web.conversations.replies({
            channel,
            ts: thread_ts,
            limit: Math.min(limit ?? 50, 200),
          });
          return { success: true, output: JSON.stringify(pick(messages)) };
        },
      ),
      download_file: defineTool(
        "download_file",
        "Save an attachment (its url_private) into your workspace at full resolution. Input: { url, name? }. Returns the absolute path.",
        z.object({ url: z.string(), name: z.string().optional() }),
        async ({ url, name }) => {
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
      ),
      upload_file: defineTool(
        "upload_file",
        "Post a file from your workspace into a conversation. Input: { path, channel, thread_ts?, title? } — thread_ts absent posts top-level.",
        z.object({
          path: z.string(),
          channel: z.string(),
          thread_ts: z.string().optional(),
          title: z.string().optional(),
        }),
        async ({ path, channel, thread_ts, title }) => {
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
      ),
      search: defineTool(
        "search",
        "Slack search, same syntax as the search box (quotes, in:#channel, from:@user, before:/after:). Hits carry a permalink — cite it. Input: { query, count? }.",
        z.object({ query: z.string(), count: z.number().optional() }),
        async ({ query, count }) => {
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
      ),
      emoji_set: defineTool(
        "emoji_set",
        "Create or replace a custom emoji from an image URL. Input: { name, url }.",
        z.object({ name: z.string(), url: z.string() }),
        async ({ name: raw, url }) => {
          if (!admin) return needsAdmin;
          const name = raw.replaceAll(":", "").trim().toLowerCase();
          await admin.admin.emoji.remove({ name }).catch(() => {});
          await admin.admin.emoji.add({ name, url });
          return { success: true, output: `:${name}: is live` };
        },
      ),
    },
  };
}
