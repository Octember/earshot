import { basename, resolve, sep } from "node:path";
import { SlackApiResponseSchema } from "../schemas/tools";

export type SlackFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: BodyInit | null },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type SlackApiResponse = { ok: boolean; error?: string } & Record<string, unknown>;

export function slackJson(value: unknown): SlackApiResponse {
  const parsed = SlackApiResponseSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: "invalid response" };
  const out: SlackApiResponse = { ok: parsed.data.ok };
  if (typeof parsed.data.error === "string") out.error = parsed.data.error;
  for (const [key, entry] of Object.entries(parsed.data)) {
    if (key !== "ok" && key !== "error") out[key] = entry;
  }
  return out;
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
