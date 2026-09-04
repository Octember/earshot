import { mkdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { ToolRegistry } from "./catalog-types";

const Api = z.object({ method: z.string(), args: z.record(z.string(), z.unknown()).optional() });
const Download = z.object({ url: z.string(), name: z.string().optional() });
const Upload = z.object({
  path: z.string(),
  channel: z.string(),
  thread_ts: z.string().optional(),
  title: z.string().optional(),
});

export function slackRegistry(deps: {
  web: WebClient;
  adminToken?: string | undefined;
  workspace: string;
}): ToolRegistry {
  const admin = deps.adminToken ? new WebClient(deps.adminToken) : null;
  return {
    name: "slack",
    skill:
      "slack_api is the Slack Web API as-is: conversations.history / conversations.replies to read beyond the thread in front of you, search.messages (search-box syntax) to find anything said here, users.info for a name. Posting and reacting go through reply and react, never here.",
    tools: {
      slack_api: {
        spec: {
          name: "slack_api",
          description:
            "Call a Slack Web API method with its documented arguments and get the raw response. Input: { method, args? } e.g. { method: 'conversations.replies', args: { channel, ts } }.",
          inputSchema: z.toJSONSchema(Api),
        },
        run: async (raw) => {
          const { method, args } = Api.parse(raw);
          if (/^(chat|reactions)\./.test(method))
            return { success: false, output: "posting and reacting go through reply and react" };
          const client =
            method.startsWith("admin.") || method.startsWith("search.") ? admin : deps.web;
          if (!client) return { success: false, output: "no admin credential is configured" };
          return { success: true, output: JSON.stringify(await client.apiCall(method, args)) };
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
    },
  };
}
