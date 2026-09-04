import type { WebClient } from "@slack/web-api";
import type { Conversation } from "./inbox";
import { textOf, userOf } from "./inbox";

const TAIL_LIMIT = 8;
const TEXT_LIMIT = 2500;

export const LEGEND =
  'Lines are [channel ts] speaker: text. Reply with channel + thread_ts (the thread root shown in the header), react with channel + ts. "→ you" after a speaker means that line is addressed to you.\n\n';

export interface RenderDeps {
  web: WebClient;
  botUserId: string;
  nameOf: (id: string) => string | null;
}

interface Line {
  user: string | null;
  text: string;
  ts: string;
  files?:
    | { name?: string | null | undefined; id?: string | undefined; mimetype?: string | undefined }[]
    | undefined;
}

function speaker(deps: RenderDeps, user: string | null, selfLabel: string): string {
  if (user === deps.botUserId) return selfLabel;
  const name = user ? deps.nameOf(user) : null;
  return `<@${user ?? "?"}>${name ? ` (${name})` : ""}`;
}

function formatLine(
  deps: RenderDeps,
  channel: string,
  line: Line,
  selfLabel: string,
  mark: string,
  limit: number,
): string {
  const files = line.files?.length
    ? ` [attached: ${line.files.map((file) => `${file.name ?? file.id} (${file.mimetype})`).join(", ")}]`
    : "";
  return `  [${channel} ${line.ts}] ${speaker(deps, line.user, selfLabel)}${mark}: ${line.text.slice(0, limit)}${files}`;
}

async function tailOf(deps: RenderDeps, convo: Conversation, before: string): Promise<Line[]> {
  if (convo.threadTs === before) return [];
  const { messages } = await deps.web.conversations.replies({
    channel: convo.channel,
    ts: convo.threadTs,
    latest: before,
    inclusive: false,
    limit: 50,
  });
  return (messages ?? [])
    .filter((m) => m.ts && m.ts < before)
    .slice(-TAIL_LIMIT)
    .map((m) => ({
      user: m.user ?? m.bot_id ?? null,
      text: m.text ?? "",
      ts: m.ts!,
      files: m.files,
    }));
}

export async function renderConversation(
  deps: RenderDeps,
  convo: Conversation,
  opts: { selfLabel: "you" | "she"; mark: string; out: string | null },
): Promise<string> {
  const head = `## <#${convo.channel}> thread=${convo.threadTs}`;
  const note = [
    ...(opts.out ? [`Out: ${opts.out}`] : []),
    ...(convo.wakeWhy ? [convo.wakeWhy] : []),
  ].join(" · ");
  const header = note ? `${head}\n${note}\n` : `${head}\n`;
  const first = convo.heard[0]!.event.ts;
  let tail: Line[] = [];
  try {
    tail = await tailOf(deps, convo, first);
  } catch {}
  const earlier =
    tail.length > 0
      ? `Earlier:\n${tail.map((line) => formatLine(deps, convo.channel, line, opts.selfLabel, "", 300)).join("\n")}\n`
      : "";
  const fresh = `New:\n${convo.heard
    .map((heard) =>
      formatLine(
        deps,
        convo.channel,
        {
          user: userOf(heard.event),
          text: textOf(heard.event),
          ts: heard.event.ts,
          files: "files" in heard.event ? heard.event.files : undefined,
        },
        opts.selfLabel,
        heard.direct ? opts.mark : "",
        TEXT_LIMIT,
      ),
    )
    .join("\n")}\n`;
  return `${header}${earlier}${fresh}`;
}

export async function renderBatch(
  deps: RenderDeps,
  convos: { convo: Conversation; out: string | null }[],
  opts: { selfLabel: "you" | "she"; mark: string },
): Promise<string> {
  const rendered = await Promise.all(
    convos.map(({ convo, out }) => renderConversation(deps, convo, { ...opts, out })),
  );
  return rendered.join("\n\n");
}
