import { basename, resolve, sep } from "node:path";
import { isRecord } from "../guard";

export type SlackFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: BodyInit | null },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type SlackApiResponse = { ok: boolean; error?: string } & Record<string, unknown>;

export function slackJson(value: unknown): SlackApiResponse {
  if (!isRecord(value)) return { ok: false, error: "invalid response" };
  return {
    ...value,
    ok: value.ok === true,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

export function createSlackApi(doFetch: SlackFetch) {
  return async (
    method: string,
    token: string,
    body: Record<string, unknown>,
  ): Promise<SlackApiResponse> => {
    const res = await doFetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(body),
    });
    return slackJson(await res.json());
  };
}

export function safeName(name: string): string {
  const base = basename(name)
    .replaceAll(/[^\w.\- ]/g, "_")
    .trim();
  return base || "file";
}

export function insideWorkspace(workspace: string, path: string): boolean {
  const root = resolve(workspace);
  const target = resolve(root, path);
  return target === root || target.startsWith(root + sep);
}

export function toolError(error: unknown): { success: false; output: string } {
  return { success: false, output: error instanceof Error ? error.message : String(error) };
}
