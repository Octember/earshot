import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolRegistry } from "./catalog-types";

const Api = z.object({ method: z.string(), args: z.record(z.string(), z.unknown()).optional() });
const Download = z.object({ url: z.string(), name: z.string().optional() });
const Upload = z.object({
  path: z.string(),
  channel: z.string(),
  thread_ts: z.string().optional(),
  title: z.string().optional(),
});

function apiTool(name: string, description: string, web: WebClient): DynamicTool {
  return {
    spec: { name, description, inputSchema: z.toJSONSchema(Api) },
    run: async (raw) => {
      const { method, args } = Api.parse(raw);
      return { success: true, output: JSON.stringify(await web.apiCall(method, args)) };
    },
  };
}

export function slackRegistry(deps: {
  web: WebClient;
  adminToken?: string | undefined;
  workspace: string;
}): ToolRegistry {
  return {
    name: "slack",
    skill:
      "slack_api is the Slack Web API as-is: conversations.history / conversations.replies to read beyond the thread in front of you, users.info for a name. Posting and reacting go through reply and react so your turn knows what it said.",
    tools: {
      slack_api: apiTool(
        "slack_api",
        "Call a Slack Web API method as yourself with its documented arguments; the raw response comes back. Input: { method, args? } e.g. { method: 'conversations.replies', args: { channel, ts } }.",
        deps.web,
      ),
      ...(deps.adminToken
        ? {
            slack_admin_api: apiTool(
              "slack_admin_api",
              "Call a Slack Web API method with the workspace admin's user token: search.messages (search-box syntax; hits carry permalinks), admin.emoji.add, anything a bot token can't. Input: { method, args? }.",
              new WebClient(deps.adminToken),
            ),
          }
        : {}),
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
    },
  };
}
