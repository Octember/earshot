import { mkdirSync } from "node:fs";
import { basename, resolve, sep } from "node:path";
import { WebClient, type ConversationsHistoryResponse } from "@slack/web-api";
import { defineTool } from "../schemas/tool";
import {
  DownloadFileArgsSchema,
  EmojiSetArgsSchema,
  ReadChannelArgsSchema,
  ReadThreadArgsSchema,
  UploadFileArgsSchema,
} from "../schemas/tools";
import type { ToolRegistry } from "./catalog-types";
import { venueCoords } from "../prompt/format";

export type SlackToolDeps = {
  web: WebClient;
  permalink: (venueId: string, ts: string) => string;
  adminToken?: string | undefined;
  workspace: string;
};

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

function toolError(error: unknown): { success: false; output: string } {
  return { success: false, output: error instanceof Error ? error.message : String(error) };
}

function cite(
  deps: SlackToolDeps,
  channelId: string,
  messages: ConversationsHistoryResponse["messages"],
) {
  return (messages ?? []).map(({ user, bot_id, text, ts, reply_count, files }) => ({
    user: user ?? bot_id ?? null,
    text,
    ts,
    reply_count,
    files,
    permalink: ts && deps.permalink(channelId, ts),
  }));
}

function insideWorkspace(workspace: string, path: string): boolean {
  const root = resolve(workspace);
  const target = resolve(root, path);
  return target === root || target.startsWith(root + sep);
}

function safeName(name: string): string {
  const base = basename(name)
    .replaceAll(/[^\w.\- ]/g, "_")
    .trim();
  return base || "file";
}

export function slackRegistry(deps: SlackToolDeps): ToolRegistry {
  const admin = deps.adminToken ? new WebClient(deps.adminToken) : null;
  return {
    name: "slack",
    skill:
      "Beyond the thread in front of you: pull a channel's recent history on demand, then open any conversation it roots. " +
      "Attachments come through at full resolution — download one into your workspace to look at or work on it, and send a file " +
      "from your workspace back into a conversation when the result IS a file. Reach for these when someone points you at a " +
      "channel, an image, or asks for something a plain message can't carry.",
    examples: [
      {
        when: "someone posts a screenshot and asks you to work with it",
        tool: "download_file",
        args: {
          url: "https://files.slack.com/files-pri/T0-F0ABC123/screenshot.png",
          name: "screenshot.png",
        },
        result:
          '{"path":"files/screenshot.png","bytes":48213} — the original file, full resolution, now in your workspace',
      },
      {
        when: "the result of your work is a file (an edited image, a generated doc)",
        tool: "upload_file",
        args: {
          path: "files/anya-cleaned.png",
          venueId: "<the conversation's #channel id>",
          threadRootId: "<its thread= value, or null for top-level>",
          title: "cleaned up",
        },
      },
      {
        when: "the room wants a new or updated custom emoji",
        tool: "emoji_set",
        args: {
          name: "anya",
          url: "https://files.slack.com/files-pri/T0-F0ABC123/anya-cleaned.png",
        },
      },
    ],
    tools: {
      read_channel: defineTool(
        "read_channel",
        "Read recent messages from a Slack channel (with permalinks for citing). Only channel-root messages — a message with reply_count > 0 roots a thread; pull its replies with read_thread. Input: { channel, limit? } — channel as <#C…> link or id.",
        ReadChannelArgsSchema,
        async ({ channel, limit }) => {
          try {
            const id = resolveChannelRef(channel);
            const { messages } = await deps.web.conversations.history({
              channel: id,
              limit: Math.min(limit ?? 20, 100),
            });
            return { success: true, output: JSON.stringify(cite(deps, id, messages).toReversed()) };
          } catch (error) {
            return toolError(error);
          }
        },
      ),
      read_thread: defineTool(
        "read_thread",
        "Read a Slack thread's replies (with permalinks for citing). Input: { channel, thread_ts, limit? } — thread_ts is the root message's ts, as returned by read_channel.",
        ReadThreadArgsSchema,
        async ({ channel, thread_ts, limit }) => {
          try {
            const id = resolveChannelRef(channel);
            const { messages } = await deps.web.conversations.replies({
              channel: id,
              ts: thread_ts,
              limit: Math.min(limit ?? 50, 200),
            });
            return { success: true, output: JSON.stringify(cite(deps, id, messages)) };
          } catch (error) {
            return toolError(error);
          }
        },
      ),
      download_file: defineTool(
        "download_file",
        "Download a message attachment (image, doc — the original, full resolution) into your workspace. Input: { url, name? } — url is the attachment's url_private from its message line; name is what to save it as. Returns the ABSOLUTE path — use it verbatim.",
        DownloadFileArgsSchema,
        async ({ url, name }) => {
          let host: string;
          try {
            host = new URL(url).host;
          } catch {
            return { success: false, output: "download_file: that isn't a URL" };
          }
          if (host !== "files.slack.com")
            return {
              success: false,
              output:
                "download_file only fetches Slack-hosted attachments (files.slack.com url_private links)",
            };
          try {
            const res = await fetch(url, {
              headers: { Authorization: `Bearer ${deps.web.token}` },
            });
            if (!res.ok) throw new Error(`file download failed: HTTP ${res.status}`);
            if ((res.headers.get("content-type") ?? "").includes("text/html"))
              throw new Error(
                "file download returned HTML — the Slack app likely lacks the files:read scope",
              );
            const bytes = new Uint8Array(await res.arrayBuffer());
            const dir = resolve(deps.workspace, "files");
            mkdirSync(dir, { recursive: true });
            const path = resolve(dir, safeName(name ?? new URL(url).pathname));
            await Bun.write(path, bytes);
            return { success: true, output: JSON.stringify({ path, bytes: bytes.length }) };
          } catch (error) {
            return toolError(error);
          }
        },
      ),
      upload_file: defineTool(
        "upload_file",
        "Send a file from your workspace into a conversation — it lands as a message with the file attached. Input: { path, venueId, threadRootId?, title? } — path is the file's ABSOLUTE path (inside your workspace; download_file and your own shell both give you one); venueId/threadRootId address it exactly like reply (threadRootId null or absent posts top-level).",
        UploadFileArgsSchema,
        async ({ path, venueId, threadRootId, title }) => {
          if (!insideWorkspace(deps.workspace, path))
            return {
              success: false,
              output: "upload_file only sends files from your own workspace",
            };
          try {
            const file = Bun.file(resolve(deps.workspace, path));
            if (!(await file.exists()))
              return { success: false, output: `no such file in your workspace: ${path}` };
            const filename = basename(path);
            const upload = {
              file: Buffer.from(await file.arrayBuffer()),
              filename,
              title: title ?? filename,
            };
            await deps.web.files.uploadV2(
              threadRootId
                ? { ...upload, channel_id: venueId, thread_ts: threadRootId }
                : { ...upload, channel_id: venueId },
            );
            return {
              success: true,
              output: `sent ${filename} into ${venueCoords({ venueId, threadRootId: threadRootId ?? null })}`,
            };
          } catch (error) {
            return toolError(error);
          }
        },
      ),
      emoji_set: defineTool(
        "emoji_set",
        "Create or replace a workspace custom emoji from an image URL. Input: { name, url } — name without colons; url must be a fetchable image (a Slack attachment's url_private works).",
        EmojiSetArgsSchema,
        async ({ name: rawName, url }) => {
          const name = rawName.replaceAll(":", "").trim().toLowerCase();
          if (!name)
            return {
              success: false,
              output:
                "emoji_set needs { name, url } — the emoji's name (no colons) and a URL of its image",
            };
          if (!admin)
            return {
              success: false,
              output:
                "custom emoji aren't wired up here yet — an admin credential is missing; a workspace admin can add it by hand meanwhile",
            };
          try {
            await admin.admin.emoji.remove({ name }).catch(() => {});
            await admin.admin.emoji.add({ name, url });
            return { success: true, output: `:${name}: is live` };
          } catch (error) {
            return toolError(error);
          }
        },
      ),
    },
  };
}
