import type { MessageEvent } from "@slack/types";
import { WebClient } from "@slack/web-api";
import { singleton } from "tsyringe";
import { Attachments, type Attachment } from "./attachments";
import { textOf, userOf, type Conversation } from "./inbox";
import { LedgerService } from "./ledger-service";
import type { Task } from "./ledger/schema";
import { Roster } from "./roster";

const TAIL_LIMIT = 8;
const TAIL_TEXT_LIMIT = 300;
const TEXT_LIMIT = 2500;

const LEGEND =
  "Lines are [channel ts] speaker: text. Attachments are saved at the paths shown.\n\n";

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

function taskLine(task: Task): string {
  const home = `<#${task.channel}>${task.threadTs ? ` thread=${task.threadTs}` : ""}`;
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
  ) {}

  async wake(convos: Conversation[], settled: Task[]): Promise<string> {
    const parts = [LEGEND + (await this.batch(convos))];
    if (settled.length > 0)
      parts.push(`Tasks:\n${settled.map((task) => taskLine(task)).join("\n")}`);
    return parts.join("\n\n");
  }

  ear(convos: Conversation[]): Promise<string> {
    return this.batch(convos);
  }

  private async batch(convos: Conversation[]): Promise<string> {
    const rendered = await Promise.all(convos.map((convo) => this.conversation(convo)));
    return rendered.join("\n\n");
  }

  private async conversation(convo: Conversation): Promise<string> {
    const parts = [this.header(convo)];
    const earlier = await this.lines(convo.channel, await this.tail(convo), TAIL_TEXT_LIMIT);
    if (earlier) parts.push(`Earlier:\n${earlier}`);
    const fresh = convo.heard.map((h) => fromEvent(h.event));
    parts.push(`New:\n${await this.lines(convo.channel, fresh, TEXT_LIMIT)}`);
    return `${parts.join("\n")}\n`;
  }

  private header(convo: Conversation): string {
    const muted = this.ledger.muted(convo.channel, convo.threadTs);
    const notes = [muted ? `Muted: ${muted}` : "", convo.wakeWhy ?? ""].filter(Boolean);
    const head = `## <#${convo.channel}> thread=${convo.threadTs}`;
    return notes.length > 0 ? `${head}\n${notes.join(" · ")}` : head;
  }

  private async tail(convo: Conversation): Promise<Line[]> {
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
        .slice(-TAIL_LIMIT);
    } catch {
      return [];
    }
  }

  private async lines(channel: string, lines: Line[], limit: number): Promise<string> {
    const rendered = await Promise.all(lines.map((line) => this.line(channel, line, limit)));
    return rendered.join("\n");
  }

  private async line(channel: string, line: Line, limit: number): Promise<string> {
    const saved = await Promise.all((line.files ?? []).map((file) => this.attachments.save(file)));
    const files = saved.length > 0 ? ` [attached: ${saved.join(", ")}]` : "";
    const text = (line.text ?? "").slice(0, limit);
    return `  [${channel} ${line.ts}] ${this.speaker(line.user ?? line.bot_id)}: ${text}${files}`;
  }

  private speaker(user: string | undefined): string {
    const name = user ? this.roster.nameOf(user) : null;
    return `<@${user ?? "?"}>${name ? ` (${name})` : ""}`;
  }
}
