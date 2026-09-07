import { existsSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Service } from "./service";
import type { Conversation } from "./inbox";
import { textOf, userOf } from "./inbox";
import { outOf } from "./ledger/stance";

const TAIL_LIMIT = 8;
const TEXT_LIMIT = 2500;

export const LEGEND =
  'Lines are [channel ts] speaker: text. "→ you" marks a line addressed to you. Attachments are saved at the paths shown.\n\n';

interface Attachment {
  id?: string | undefined;
  name?: string | null | undefined;
  mimetype?: string | undefined;
  url_private?: string | undefined;
}

interface Line {
  user?: string | undefined;
  bot_id?: string | undefined;
  text?: string | undefined;
  ts?: string | undefined;
  files?: Attachment[] | undefined;
}

type Voice = "you" | "she";

function speaker(host: Service, user: string | undefined, voice: Voice): string {
  if (user === host.botPrincipalId) return voice;
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
  voice: Voice,
  direct: boolean,
  limit: number,
): Promise<string> {
  const files = line.files?.length
    ? ` [attached: ${(await Promise.all(line.files.map((file) => save(host, file)))).join(", ")}]`
    : "";
  const mark = direct ? (voice === "you" ? " → you" : " → her") : "";
  return `  [${channel} ${line.ts}] ${speaker(host, line.user ?? line.bot_id, voice)}${mark}: ${(line.text ?? "").slice(0, limit)}${files}`;
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
  return (messages ?? []).filter((m) => m.ts && m.ts < before).slice(-TAIL_LIMIT);
}

async function renderConversation(
  host: Service,
  identityId: string,
  convo: Conversation,
  voice: Voice,
): Promise<string> {
  const head = `## <#${convo.channel}> thread=${convo.threadTs}`;
  const out = outOf(host.db, identityId, convo.channel, convo.threadTs);
  const note = [...(out ? [`Out: ${out}`] : []), ...(convo.wakeWhy ? [convo.wakeWhy] : [])].join(
    " · ",
  );
  const header = note ? `${head}\n${note}\n` : `${head}\n`;
  const first = convo.heard[0]!.event.ts;
  let tail: Line[] = [];
  try {
    tail = await tailOf(host, convo, first);
  } catch {}
  const earlierLines = await Promise.all(
    tail.map((line) => formatLine(host, convo.channel, line, voice, false, 300)),
  );
  const earlier = earlierLines.length > 0 ? `Earlier:\n${earlierLines.join("\n")}\n` : "";
  const freshLines = await Promise.all(
    convo.heard.map((heard) =>
      formatLine(
        host,
        convo.channel,
        {
          user: userOf(heard.event) ?? undefined,
          text: textOf(heard.event),
          ts: heard.event.ts,
          files: "files" in heard.event ? heard.event.files : undefined,
        },
        voice,
        heard.direct,
        TEXT_LIMIT,
      ),
    ),
  );
  return `${header}${earlier}New:\n${freshLines.join("\n")}\n`;
}

export async function renderBatch(
  host: Service,
  identityId: string,
  convos: Conversation[],
  voice: Voice,
): Promise<string> {
  const rendered = await Promise.all(
    convos.map((convo) => renderConversation(host, identityId, convo, voice)),
  );
  return rendered.join("\n\n");
}
