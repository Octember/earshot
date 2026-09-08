import { WebClient } from "@slack/web-api";
import type { MessageElement } from "@slack/web-api/dist/types/response/ConversationsRepliesResponse";
import { singleton } from "tsyringe";
import { Attachments } from "./attachments";
import { LedgerService } from "./ledger-service";
import type { Conversation, Task } from "./ledger/schema";
import { Roster } from "./roster";

const TAIL_LIMIT = 8;
const TAIL_TEXT_LIMIT = 300;
const TEXT_LIMIT = 2500;

const LEGEND =
  "Lines are [channel ts] speaker: text. Attachments are saved at the paths shown.\n\n";

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

  async response(convos: Conversation[], settled: Task[]): Promise<string> {
    const parts = convos.length > 0 ? [LEGEND + (await this.batch(convos))] : [];
    if (settled.length > 0)
      parts.push(`Tasks:\n${settled.map((task) => taskLine(task)).join("\n")}`);
    return parts.join("\n\n");
  }

  async noise(convos: Conversation[]): Promise<string> {
    return LEGEND + (await this.batch(convos));
  }

  private async batch(convos: Conversation[]): Promise<string> {
    const results = await Promise.allSettled(convos.map((convo) => this.conversation(convo)));
    return results
      .filter((r) => r.status === "fulfilled")
      .map((r) => r.value)
      .join("\n\n");
  }

  private async conversation(convo: Conversation): Promise<string> {
    const parts = [this.header(convo)];
    const { earlier, fresh } = await this.messages(convo);
    if (earlier.length > 0)
      parts.push(`Earlier:\n${await this.lines(convo.channel, earlier, TAIL_TEXT_LIMIT)}`);
    parts.push(`New:\n${await this.lines(convo.channel, fresh, TEXT_LIMIT)}`);
    return `${parts.join("\n")}\n`;
  }

  private header(convo: Conversation): string {
    const muted = this.ledger.muted(convo.channel, convo.threadTs);
    const head = `## <#${convo.channel}> thread=${convo.threadTs}`;
    return muted ? `${head}\nMuted: ${muted}` : head;
  }

  private async messages(
    convo: Conversation,
  ): Promise<{ earlier: MessageElement[]; fresh: MessageElement[] }> {
    const all: MessageElement[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.web.conversations.replies({
        channel: convo.channel,
        ts: convo.threadTs,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      all.push(...(page.messages ?? []));
      cursor = page.response_metadata?.next_cursor;
    } while (cursor);
    return {
      earlier: all.filter((m) => m.ts && m.ts < convo.since).slice(-TAIL_LIMIT),
      fresh: all.filter((m) => m.ts && m.ts >= convo.since),
    };
  }

  private async lines(channel: string, lines: MessageElement[], limit: number): Promise<string> {
    const rendered = await Promise.all(lines.map((line) => this.line(channel, line, limit)));
    return rendered.join("\n");
  }

  private async line(channel: string, line: MessageElement, limit: number): Promise<string> {
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
