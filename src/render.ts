import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Service } from "./service";
import type { Conversation } from "./inbox";
import { textOf, userOf } from "./inbox";

const TAIL_LIMIT = 8;
const TEXT_LIMIT = 2500;

export const LEGEND =
  'Lines are [channel ts] speaker: text. Reply with channel + thread_ts (the thread root shown in the header), react with channel + ts. "→ you" after a speaker means that line is addressed to you. Attachments are already saved at the paths shown.\n\n';

interface Attachment {
  id?: string | undefined;
  name?: string | null | undefined;
  mimetype?: string | undefined;
  url_private?: string | undefined;
}

interface Line {
  user: string | null;
  text: string;
  ts: string;
  files?: Attachment[] | undefined;
}

function speaker(host: Service, user: string | null, selfLabel: string): string {
  if (user === host.botPrincipalId) return selfLabel;
  const name = user ? host.nameOf(user) : null;
  return `<@${user ?? "?"}>${name ? ` (${name})` : ""}`;
}

async function save(host: Service, file: Attachment): Promise<string> {
  const label = `${file.name ?? file.id} (${file.mimetype})`;
  if (!file.url_private || !file.id) return label;
  const dir = join(host.cwd, "files");
  const path = join(dir, `${file.id}-${basename(file.name ?? "file")}`);
  if (!existsSync(path)) {
    try {
      const res = await fetch(file.url_private, {
        headers: { Authorization: `Bearer ${host.web.token}` },
      });
      if (!res.ok) return label;
      mkdirSync(dir, { recursive: true });
      await Bun.write(path, await res.arrayBuffer());
    } catch {
      return label;
    }
  }
  return `${path} (${file.mimetype})`;
}

async function formatLine(
  host: Service,
  channel: string,
  line: Line,
  selfLabel: string,
  mark: string,
  limit: number,
): Promise<string> {
  const files = line.files?.length
    ? ` [attached: ${(await Promise.all(line.files.map((file) => save(host, file)))).join(", ")}]`
    : "";
  return `  [${channel} ${line.ts}] ${speaker(host, line.user, selfLabel)}${mark}: ${line.text.slice(0, limit)}${files}`;
}

async function tailOf(host: Service, convo: Conversation, before: string): Promise<Line[]> {
  if (convo.threadTs === before) return [];
  const { messages } = await host.web.conversations.replies({
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
  host: Service,
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
    tail = await tailOf(host, convo, first);
  } catch {}
  const earlierLines = await Promise.all(
    tail.map((line) => formatLine(host, convo.channel, line, opts.selfLabel, "", 300)),
  );
  const earlier = earlierLines.length > 0 ? `Earlier:\n${earlierLines.join("\n")}\n` : "";
  const freshLines = await Promise.all(
    convo.heard.map((heard) =>
      formatLine(
        host,
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
    ),
  );
  return `${header}${earlier}New:\n${freshLines.join("\n")}\n`;
}

export async function renderBatch(
  host: Service,
  convos: { convo: Conversation; out: string | null }[],
  opts: { selfLabel: "you" | "she"; mark: string },
): Promise<string> {
  const rendered = await Promise.all(
    convos.map(({ convo, out }) => renderConversation(host, convo, { ...opts, out })),
  );
  return rendered.join("\n\n");
}
