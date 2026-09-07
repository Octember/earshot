import type { MessageEvent } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { inject, singleton } from "tsyringe";
import { Attachments, type Attachment } from "./attachments";
import { textOf, userOf, type Conversation } from "./inbox";
import { LedgerService } from "./ledger-service";
import type { Task } from "./ledger/schema";
import { Roster } from "./roster";
import { BOT_USER_ID } from "./tokens";

const TAIL_LIMIT = 8;
const TAIL_TEXT_LIMIT = 300;
const TEXT_LIMIT = 2500;

const LEGEND =
  'Lines are [channel ts] speaker: text. "→ you" marks a line addressed to you. Attachments are saved at the paths shown.\n\n';

/** One message, whichever way it reached us: a socket event or a fetched reply. */
interface Line {
  user?: string | undefined;
  bot_id?: string | undefined;
  text?: string | undefined;
  ts?: string | undefined;
  files?: Attachment[] | undefined;
}

function fromEvent(event: MessageEvent): Line {
  return {
    user: userOf(event) ?? undefined,
    text: textOf(event),
    ts: event.ts,
    files: "files" in event ? event.files : undefined,
  };
}

/** How the reader refers to her: the resident reads as "you", the ear reads about "her". */
interface Voice {
  self: string;
  addressed: string;
}
const YOU: Voice = { self: "you", addressed: " → you" };
const SHE: Voice = { self: "she", addressed: " → her" };

function taskLine(task: Task): string {
  const home = `<#${task.homeVenueId}>${task.homeThreadRootId ? ` thread=${task.homeThreadRootId}` : ""}`;
  const state =
    task.status === "done"
      ? `${task.outcome}: ${task.report}`
      : `waiting on a human: ${task.waitingWhy}`;
  return `- ${home} · ${task.id} "${task.title}" · ${state}`;
}

@singleton()
export class PromptRenderer {
  constructor(
    private readonly web: WebClient,
    private readonly roster: Roster,
    private readonly ledger: LedgerService,
    private readonly attachments: Attachments,
    @inject(BOT_USER_ID) private readonly botUserId: string,
  ) {}

  /** What the resident reads on a wake: the legend, her conversations, and her tasks that settled since she last looked. */
  async wake(convos: Conversation[], settled: Task[]): Promise<string> {
    const parts = [LEGEND + (await this.batch(convos, YOU))];
    if (settled.length > 0)
      parts.push(`Tasks:\n${settled.map((task) => taskLine(task)).join("\n")}`);
    return parts.join("\n\n");
  }

  /** What the ear reads: the same conversations, about her rather than to her. */
  ear(convos: Conversation[]): Promise<string> {
    return this.batch(convos, SHE);
  }

  private async batch(convos: Conversation[], voice: Voice): Promise<string> {
    const rendered = await Promise.all(convos.map((convo) => this.conversation(convo, voice)));
    return rendered.join("\n\n");
  }

  private async conversation(convo: Conversation, voice: Voice): Promise<string> {
    const parts = [this.header(convo)];
    const earlier = await this.lines(convo.channel, await this.tail(convo), voice, TAIL_TEXT_LIMIT);
    if (earlier) parts.push(`Earlier:\n${earlier}`);
    const fresh = convo.heard.map((h) => ({ line: fromEvent(h.event), direct: h.direct }));
    parts.push(`New:\n${await this.lines(convo.channel, fresh, voice, TEXT_LIMIT)}`);
    return `${parts.join("\n")}\n`;
  }

  private header(convo: Conversation): string {
    const out = this.ledger.outOf(convo.channel, convo.threadTs);
    const notes = [out ? `Out: ${out}` : "", convo.wakeWhy ?? ""].filter(Boolean);
    const head = `## <#${convo.channel}> thread=${convo.threadTs}`;
    return notes.length > 0 ? `${head}\n${notes.join(" · ")}` : head;
  }

  /** Up to TAIL_LIMIT replies from before the first heard message; Slack is the message store. */
  private async tail(convo: Conversation): Promise<{ line: Line; direct: boolean }[]> {
    const before = convo.heard[0]!.event.ts;
    if (convo.threadTs === before) return [];
    try {
      const { messages } = await this.web.conversations.replies({
        channel: convo.channel,
        ts: convo.threadTs,
        latest: before,
        inclusive: false,
        limit: 50,
      });
      return (messages ?? [])
        .filter((line: Line) => line.ts && line.ts < before)
        .slice(-TAIL_LIMIT)
        .map((line: Line) => ({ line, direct: false }));
    } catch {
      return [];
    }
  }

  private async lines(
    channel: string,
    lines: { line: Line; direct: boolean }[],
    voice: Voice,
    limit: number,
  ): Promise<string> {
    const rendered = await Promise.all(
      lines.map(({ line, direct }) => this.line(channel, line, direct, voice, limit)),
    );
    return rendered.join("\n");
  }

  private async line(
    channel: string,
    line: Line,
    direct: boolean,
    voice: Voice,
    limit: number,
  ): Promise<string> {
    const saved = await Promise.all((line.files ?? []).map((file) => this.attachments.save(file)));
    const files = saved.length > 0 ? ` [attached: ${saved.join(", ")}]` : "";
    const mark = direct ? voice.addressed : "";
    const text = (line.text ?? "").slice(0, limit);
    return `  [${channel} ${line.ts}] ${this.speaker(line.user ?? line.bot_id, voice)}${mark}: ${text}${files}`;
  }

  private speaker(user: string | undefined, voice: Voice): string {
    if (user === this.botUserId) return voice.self;
    const name = user ? this.roster.nameOf(user) : null;
    return `<@${user ?? "?"}>${name ? ` (${name})` : ""}`;
  }
}
