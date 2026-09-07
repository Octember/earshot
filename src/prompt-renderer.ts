import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { WebClient } from "@slack/web-api";
import { inject, singleton } from "tsyringe";
import type { Conversation } from "./inbox";
import { textOf, userOf } from "./inbox";
import { LEDGER, type Ledger } from "./ledger/db";
import { outOf } from "./ledger/stance";
import { Roster } from "./roster";
import { BOT_USER_ID } from "./tokens";
import { Workspaces } from "./workspaces";

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

export type Voice = "you" | "she";

@singleton()
export class PromptRenderer {
  constructor(
    private readonly web: WebClient,
    private readonly roster: Roster,
    @inject(LEDGER) private readonly db: Ledger,
    private readonly workspaces: Workspaces,
    @inject(BOT_USER_ID) private readonly botUserId: string,
  ) {}

  async batch(identityId: string, convos: Conversation[], voice: Voice): Promise<string> {
    const rendered = await Promise.all(
      convos.map((convo) => this.conversation(identityId, convo, voice)),
    );
    return rendered.join("\n\n");
  }

  private async conversation(
    identityId: string,
    convo: Conversation,
    voice: Voice,
  ): Promise<string> {
    const head = `## <#${convo.channel}> thread=${convo.threadTs}`;
    const out = outOf(this.db, identityId, convo.channel, convo.threadTs);
    const note = [...(out ? [`Out: ${out}`] : []), ...(convo.wakeWhy ? [convo.wakeWhy] : [])].join(
      " · ",
    );
    const header = note ? `${head}\n${note}\n` : `${head}\n`;
    const first = convo.heard[0]!.event.ts;
    let tail: Line[] = [];
    try {
      tail = await this.tail(convo, first);
    } catch {}
    const earlierLines = await Promise.all(
      tail.map((line) => this.line(convo.channel, line, voice, false, 300)),
    );
    const earlier = earlierLines.length > 0 ? `Earlier:\n${earlierLines.join("\n")}\n` : "";
    const freshLines = await Promise.all(
      convo.heard.map((heard) =>
        this.line(
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

  private async tail(convo: Conversation, before: string): Promise<Line[]> {
    if (convo.threadTs === before) return [];
    const { messages } = await this.web.conversations.replies({
      channel: convo.channel,
      ts: convo.threadTs,
      latest: before,
      inclusive: false,
      limit: 50,
    });
    return (messages ?? []).filter((m: Line) => m.ts && m.ts < before).slice(-TAIL_LIMIT);
  }

  private async line(
    channel: string,
    line: Line,
    voice: Voice,
    direct: boolean,
    limit: number,
  ): Promise<string> {
    const files = line.files?.length
      ? ` [attached: ${(await Promise.all(line.files.map((file) => this.save(file)))).join(", ")}]`
      : "";
    const mark = direct ? (voice === "you" ? " → you" : " → her") : "";
    return `  [${channel} ${line.ts}] ${this.speaker(line.user ?? line.bot_id, voice)}${mark}: ${(line.text ?? "").slice(0, limit)}${files}`;
  }

  private speaker(user: string | undefined, voice: Voice): string {
    if (user === this.botUserId) return voice;
    const name = user ? this.roster.nameOf(user) : null;
    return `<@${user ?? "?"}>${name ? ` (${name})` : ""}`;
  }

  private async save(file: Attachment): Promise<string> {
    const label = `${file.name ?? file.id} (${file.mimetype})`;
    if (!file.url_private || !file.id) return label;
    const path = join(this.workspaces.files(), `${file.id}-${basename(file.name ?? "file")}`);
    if (!existsSync(path)) {
      try {
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${this.web.token}` },
        });
        if (!res.ok) return label;
        await Bun.write(path, await res.arrayBuffer());
      } catch {
        return label;
      }
    }
    return `${path} (${file.mimetype})`;
  }
}
