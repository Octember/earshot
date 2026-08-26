import { basename, resolve } from "node:path";
import type { SlackFetch, SlackApiResponse } from "./slack-api";
import { slackJson } from "./slack-api";
import { venueCoords } from "../prompt/format";

export async function uploadFileToSlack(
  doFetch: SlackFetch,
  api: (method: string, token: string, body: Record<string, unknown>) => Promise<SlackApiResponse>,
  opts: {
    botToken: string;
    workspace: string;
    path: string;
    venueId: string;
    threadRootId?: string | undefined;
    title?: string | undefined;
  },
): Promise<{ ok: true; output: string } | { ok: false; output: string }> {
  const file = Bun.file(resolve(opts.workspace, opts.path));
  if (!(await file.exists())) {
    return { ok: false, output: `no such file in your workspace: ${opts.path}` };
  }
  const bytes = await file.bytes();
  const filename = basename(opts.path);
  const ticketRes = await doFetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.botToken}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ filename, length: String(bytes.length) }).toString(),
  });
  const ticket = slackJson(await ticketRes.json());
  if (!ticket.ok || typeof ticket.upload_url !== "string" || typeof ticket.file_id !== "string") {
    return {
      ok: false,
      output: `upload failed: ${ticket.error ?? "no upload url"}${ticket.error === "missing_scope" ? " — the Slack app needs the files:write scope" : ""}`,
    };
  }
  const put = await doFetch(ticket.upload_url, { method: "POST", body: bytes });
  if (!put.ok) {
    return { ok: false, output: `upload failed: HTTP ${put.status} sending the file bytes` };
  }
  const done = await api("files.completeUploadExternal", opts.botToken, {
    files: [{ id: ticket.file_id, title: opts.title ?? filename }],
    channel_id: opts.venueId,
    ...(opts.threadRootId ? { thread_ts: opts.threadRootId } : {}),
  });
  if (!done.ok) return { ok: false, output: `upload failed: ${done.error}` };
  return {
    ok: true,
    output: `sent ${filename} into ${venueCoords({ venueId: opts.venueId, threadRootId: opts.threadRootId ?? null })}`,
  };
}
