import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { SlackAdapter } from "@bevyl-ai/agent-tools";
import type { ActionClass } from "../policy/broker";
import type { ToolRegistry } from "./catalog-types";
import { createSlackApi, insideWorkspace, safeName, toolError, type SlackFetch } from "./slack-api";
import { uploadFileToSlack } from "./slack-upload";
import { defineSlackTool } from "../schemas/tool";
import {
  DownloadFileArgsSchema,
  EmojiSetArgsSchema,
  ReadChannelArgsSchema,
  ReadThreadArgsSchema,
  UploadFileArgsSchema,
} from "../schemas/tools";

export type SlackToolDeps = {
  adapter: SlackAdapter;
  botToken: string;
  adminToken?: string | undefined;
  workspace: string;
  fetch?: SlackFetch | undefined;
};

function readChannelTool(deps: SlackToolDeps) {
  return defineSlackTool(
    "read_channel",
    "Read recent messages from a Slack channel (with permalinks for citing). Only channel-root messages — a message with reply_count > 0 roots a thread; pull its replies with read_thread. Input: { channel, limit? } — channel as <#C…> link or id.",
    ReadChannelArgsSchema,
    async ({ channel, limit }) => {
      try {
        const msgs = await deps.adapter.readHistory(channel, Math.min(limit ?? 20, 100));
        return { success: true, output: JSON.stringify(msgs) };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

function readThreadTool(deps: SlackToolDeps) {
  return defineSlackTool(
    "read_thread",
    "Read a Slack thread's replies (with permalinks for citing). Input: { channel, thread_ts, limit? } — thread_ts is the root message's ts, as returned by read_channel.",
    ReadThreadArgsSchema,
    async ({ channel, thread_ts, limit }) => {
      try {
        const msgs = await deps.adapter.readThread(channel, thread_ts, Math.min(limit ?? 50, 200));
        return { success: true, output: JSON.stringify(msgs) };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

function downloadFileTool(deps: SlackToolDeps) {
  return defineSlackTool(
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
      if (host !== "files.slack.com") {
        return {
          success: false,
          output:
            "download_file only fetches Slack-hosted attachments (files.slack.com url_private links)",
        };
      }
      try {
        const bytes = await deps.adapter.downloadFile(url);
        const dir = resolve(deps.workspace, "files");
        mkdirSync(dir, { recursive: true });
        const filename = safeName(name ?? new URL(url).pathname);
        await Bun.write(resolve(dir, filename), bytes);
        return {
          success: true,
          output: JSON.stringify({ path: resolve(dir, filename), bytes: bytes.length }),
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );
}

function uploadFileTool(
  deps: SlackToolDeps,
  doFetch: SlackFetch,
  api: ReturnType<typeof createSlackApi>,
) {
  return defineSlackTool(
    "upload_file",
    "Send a file from your workspace into a conversation — it lands as a message with the file attached. Input: { path, venueId, threadRootId?, title? } — path is the file's ABSOLUTE path (inside your workspace; download_file and your own shell both give you one); venueId/threadRootId address it exactly like reply (threadRootId null or absent posts top-level).",
    UploadFileArgsSchema,
    async ({ path, venueId, threadRootId, title }) => {
      if (!insideWorkspace(deps.workspace, path)) {
        return { success: false, output: "upload_file only sends files from your own workspace" };
      }
      try {
        const result = await uploadFileToSlack(doFetch, api, {
          botToken: deps.botToken,
          workspace: deps.workspace,
          path,
          venueId,
          ...(threadRootId !== undefined && threadRootId !== null ? { threadRootId } : {}),
          ...(title !== undefined ? { title } : {}),
        });
        return result.ok
          ? { success: true, output: result.output }
          : { success: false, output: result.output };
      } catch (error) {
        return toolError(error);
      }
    },
    { actionClasses: (): ActionClass[] => ["outward"] },
  );
}

function emojiSetTool(deps: SlackToolDeps, api: ReturnType<typeof createSlackApi>) {
  return defineSlackTool(
    "emoji_set",
    "Create or replace a workspace custom emoji from an image URL. Input: { name, url } — name without colons; url must be a fetchable image (a Slack attachment's url_private works). Consequential — may wait for a go-ahead.",
    EmojiSetArgsSchema,
    async ({ name: rawName, url }) => {
      const name = rawName.replaceAll(":", "").trim().toLowerCase();
      if (!name) {
        return {
          success: false,
          output:
            "emoji_set needs { name, url } — the emoji's name (no colons) and a URL of its image",
        };
      }
      if (!deps.adminToken) {
        return {
          success: false,
          output:
            "custom emoji aren't wired up here yet — an admin credential is missing; a workspace admin can add it by hand meanwhile",
        };
      }
      try {
        let result = await api("admin.emoji.add", deps.adminToken, { name, url });
        if (
          !result.ok &&
          (result.error === "emoji_already_exists" || result.error === "error_name_taken")
        ) {
          const removed = await api("admin.emoji.remove", deps.adminToken, { name });
          if (!removed.ok) {
            return {
              success: false,
              output: `emoji_set: :${name}: exists and couldn't be replaced (${removed.error})`,
            };
          }
          result = await api("admin.emoji.add", deps.adminToken, { name, url });
        }
        if (!result.ok) return { success: false, output: `emoji_set failed: ${result.error}` };
        return { success: true, output: `:${name}: is live` };
      } catch (error) {
        return toolError(error);
      }
    },
    { actionClasses: (): ActionClass[] => ["outward"] },
  );
}

export function buildSlackTools(deps: SlackToolDeps) {
  const doFetch: SlackFetch =
    deps.fetch ??
    (async (url, init) => {
      const requestInit: RequestInit = {};
      if (init?.method) requestInit.method = init.method;
      if (init?.headers) requestInit.headers = init.headers;
      if (init?.body !== undefined) requestInit.body = init.body;
      const res = await fetch(url, requestInit);
      return { ok: res.ok, status: res.status, json: () => res.json() };
    });
  const api = createSlackApi(doFetch);
  return {
    read_channel: readChannelTool(deps),
    read_thread: readThreadTool(deps),
    download_file: downloadFileTool(deps),
    upload_file: uploadFileTool(deps, doFetch, api),
    emoji_set: emojiSetTool(deps, api),
  };
}

export function slackRegistry(deps: SlackToolDeps): ToolRegistry {
  return {
    name: "slack",
    skill:
      "Beyond the thread in front of you: pull a channel's recent history on demand, then open any conversation it roots. " +
      "Attachments come through at full resolution — download one into your workspace to look at or work on it, and send a file " +
      "from your workspace back into a conversation when the result IS a file. Reach for these when someone points you at a " +
      "channel, an image, or asks for something a plain message can't carry. Changing the workspace's custom emoji is " +
      "consequential and waits for a go-ahead.",
    examples: [
      {
        when: "someone posts a screenshot and asks you to work with it",
        tool: "download_file",
        args: {
          url: "https://files.slack.com/files-pri/T0-F0ABC123/screenshot.png",
          name: "screenshot.png",
        },
        result:
          '{"path":"files/screenshot.png","bytes":48213,"mimetype":"image/png"} — the original file, full resolution, now in your workspace',
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
        when: "the room wants a new or updated custom emoji (needs a go-ahead)",
        tool: "emoji_set",
        args: {
          name: "anya",
          url: "https://files.slack.com/files-pri/T0-F0ABC123/anya-cleaned.png",
        },
      },
    ],
    tools: buildSlackTools(deps),
  };
}
