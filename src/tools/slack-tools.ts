import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ActionClass } from "../policy/broker";
import type { ToolRegistry } from "./catalog";
import {
  createSlackApi,
  insideWorkspace,
  safeName,
  slackJson,
  toolError,
  type SlackFetch,
} from "./slack-api";

export type SlackToolDeps = {
  readHistory(channel: string, limit: number): Promise<unknown>;
  readThread(channel: string, threadTs: string, limit: number): Promise<unknown>;
  downloadFile(urlPrivate: string): Promise<Uint8Array>;
  botToken: string;
  adminToken?: string | undefined;
  workspace: string;
  fetch?: SlackFetch | undefined;
};

export type { SlackFetch };

function readChannelTool(deps: SlackToolDeps) {
  return {
    run: async (args: unknown) => {
      const rawArgs = (args ?? {}) as { channel?: string; limit?: number };
      if (!rawArgs.channel) {
        return {
          success: false,
          output: "read_channel needs a { channel } — mention it as #channel so its id resolves",
        };
      }
      try {
        const msgs = await deps.readHistory(rawArgs.channel, Math.min(rawArgs.limit ?? 20, 100));
        return { success: true, output: JSON.stringify(msgs) };
      } catch (error) {
        return toolError(error);
      }
    },
    description:
      "Read recent messages from a Slack channel (with permalinks for citing). Only channel-root messages — a message with reply_count > 0 roots a thread; pull its replies with read_thread. Input: { channel, limit? } — channel as <#C…> link or id.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel"],
      properties: { channel: { type: "string" }, limit: { type: "number" } },
    },
  };
}

function readThreadTool(deps: SlackToolDeps) {
  return {
    run: async (args: unknown) => {
      const rawArgs = (args ?? {}) as { channel?: string; thread_ts?: string; limit?: number };
      if (!rawArgs.channel || !rawArgs.thread_ts) {
        return {
          success: false,
          output:
            "read_thread needs { channel, thread_ts } — thread_ts is the root message's ts from read_channel",
        };
      }
      try {
        const msgs = await deps.readThread(
          rawArgs.channel,
          rawArgs.thread_ts,
          Math.min(rawArgs.limit ?? 50, 200),
        );
        return { success: true, output: JSON.stringify(msgs) };
      } catch (error) {
        return toolError(error);
      }
    },
    description:
      "Read a Slack thread's replies (with permalinks for citing). Input: { channel, thread_ts, limit? } — thread_ts is the root message's ts, as returned by read_channel.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["channel", "thread_ts"],
      properties: {
        channel: { type: "string" },
        thread_ts: { type: "string" },
        limit: { type: "number" },
      },
    },
  };
}

function downloadFileTool(deps: SlackToolDeps) {
  return {
    run: async (args: unknown) => {
      const rawArgs = (args ?? {}) as { url?: string; name?: string };
      if (!rawArgs.url) {
        return {
          success: false,
          output:
            "download_file needs { url } — an attachment's url_private, from the message that carried it",
        };
      }
      let host: string;
      try {
        host = new URL(rawArgs.url).host;
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
        const bytes = await deps.downloadFile(rawArgs.url);
        const dir = resolve(deps.workspace, "files");
        mkdirSync(dir, { recursive: true });
        const name = safeName(rawArgs.name ?? new URL(rawArgs.url).pathname);
        await Bun.write(resolve(dir, name), bytes);
        return {
          success: true,
          output: JSON.stringify({ path: resolve(dir, name), bytes: bytes.length }),
        };
      } catch (error) {
        return toolError(error);
      }
    },
    description:
      "Download a message attachment (image, doc — the original, full resolution) into your workspace. Input: { url, name? } — url is the attachment's url_private from its message line; name is what to save it as. Returns the ABSOLUTE path — use it verbatim.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: { url: { type: "string" }, name: { type: "string" } },
    },
  };
}

function uploadFileTool(
  deps: SlackToolDeps,
  doFetch: SlackFetch,
  api: ReturnType<typeof createSlackApi>,
) {
  return {
    run: async (args: unknown) => {
      const rawArgs = (args ?? {}) as {
        path?: string;
        venueId?: string;
        threadRootId?: string | null;
        title?: string;
      };
      if (!rawArgs.path || !rawArgs.venueId) {
        return {
          success: false,
          output:
            "upload_file needs { path, venueId } — path is the file's ABSOLUTE path; venueId is the conversation's <#…>",
        };
      }
      if (!insideWorkspace(deps.workspace, rawArgs.path)) {
        return { success: false, output: "upload_file only sends files from your own workspace" };
      }
      try {
        const file = Bun.file(resolve(deps.workspace, rawArgs.path));
        if (!(await file.exists())) {
          return { success: false, output: `no such file in your workspace: ${rawArgs.path}` };
        }
        const bytes = await file.bytes();
        const filename = basename(rawArgs.path);
        const ticketRes = await doFetch("https://slack.com/api/files.getUploadURLExternal", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${deps.botToken}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ filename, length: String(bytes.length) }).toString(),
        });
        const ticket = slackJson(await ticketRes.json());
        if (
          !ticket.ok ||
          typeof ticket.upload_url !== "string" ||
          typeof ticket.file_id !== "string"
        ) {
          return {
            success: false,
            output: `upload failed: ${ticket.error ?? "no upload url"}${ticket.error === "missing_scope" ? " — the Slack app needs the files:write scope" : ""}`,
          };
        }
        const put = await doFetch(ticket.upload_url, { method: "POST", body: bytes });
        if (!put.ok) {
          return {
            success: false,
            output: `upload failed: HTTP ${put.status} sending the file bytes`,
          };
        }
        const done = await api("files.completeUploadExternal", deps.botToken, {
          files: [{ id: ticket.file_id, title: rawArgs.title ?? filename }],
          channel_id: rawArgs.venueId,
          ...(rawArgs.threadRootId ? { thread_ts: rawArgs.threadRootId } : {}),
        });
        if (!done.ok) return { success: false, output: `upload failed: ${done.error}` };
        return {
          success: true,
          output: `sent ${filename} into <#${rawArgs.venueId}>${rawArgs.threadRootId ? ` thread=${rawArgs.threadRootId}` : ""}`,
        };
      } catch (error) {
        return toolError(error);
      }
    },
    description:
      "Send a file from your workspace into a conversation — it lands as a message with the file attached. Input: { path, venueId, threadRootId?, title? } — path is the file's ABSOLUTE path (inside your workspace; download_file and your own shell both give you one); venueId/threadRootId address it exactly like reply (threadRootId null or absent posts top-level).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "venueId"],
      properties: {
        path: { type: "string" },
        venueId: { type: "string" },
        threadRootId: { type: ["string", "null"] },
        title: { type: "string" },
      },
    },
  };
}

function emojiSetTool(deps: SlackToolDeps, api: ReturnType<typeof createSlackApi>) {
  return {
    actionClasses: (): ActionClass[] => ["outward"],
    run: async (args: unknown) => {
      const rawArgs = (args ?? {}) as { name?: string; url?: string };
      const name = rawArgs.name?.replaceAll(":", "").trim().toLowerCase();
      if (!name || !rawArgs.url) {
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
        let result = await api("admin.emoji.add", deps.adminToken, { name, url: rawArgs.url });
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
          result = await api("admin.emoji.add", deps.adminToken, { name, url: rawArgs.url });
        }
        if (!result.ok) return { success: false, output: `emoji_set failed: ${result.error}` };
        return { success: true, output: `:${name}: is live` };
      } catch (error) {
        return toolError(error);
      }
    },
    description:
      "Create or replace a workspace custom emoji from an image URL. Input: { name, url } — name without colons; url must be a fetchable image (a Slack attachment's url_private works). Consequential — may wait for a go-ahead.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["name", "url"],
      properties: { name: { type: "string" }, url: { type: "string" } },
    },
  };
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
