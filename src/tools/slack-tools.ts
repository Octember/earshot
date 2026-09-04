import { WebClient } from "@slack/web-api";
import { z } from "zod";
import type { DynamicTool } from "@bevyl-ai/agent-tools";

const Api = z.object({ method: z.string(), args: z.record(z.string(), z.unknown()).optional() });

function apiTool(name: string, description: string, web: WebClient): DynamicTool {
  return {
    spec: { name, description, inputSchema: z.toJSONSchema(Api) },
    run: async (raw) => {
      const { method, args } = Api.parse(raw);
      return { success: true, output: JSON.stringify(await web.apiCall(method, args)) };
    },
  };
}

export function slackTools(deps: {
  web: WebClient;
  adminToken?: string | undefined;
}): DynamicTool[] {
  return [
    apiTool(
      "slack_api",
      "Call a Slack Web API method as yourself with its documented arguments; the raw response comes back. Input: { method, args? }. conversations.replies { channel, ts } reads a thread beyond what you were shown; users.info { user } names an id. To send a file: files.getUploadURLExternal { filename, length }, POST the bytes to the upload_url from your shell, then files.completeUploadExternal { files: [{ id }], channel_id, thread_ts? }. Posting and reacting go through reply and react so your turn knows what it said.",
      deps.web,
    ),
    ...(deps.adminToken
      ? [
          apiTool(
            "slack_admin_api",
            "Call a Slack Web API method with the workspace admin's user token: search.messages (search-box syntax; hits carry permalinks), admin.emoji.add, anything a bot token can't. Input: { method, args? }.",
            new WebClient(deps.adminToken),
          ),
        ]
      : []),
  ];
}
