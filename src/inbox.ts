import type { MessageEvent } from "@slack/types";

export interface Heard {
  event: MessageEvent;
  direct: boolean;
  judged: boolean;
  seq: number;
}

export interface Conversation {
  channel: string;
  threadTs: string;
  heard: Heard[];
  wakeWhy: string | null;
}

export function convoKey(channel: string, threadTs: string | null): string {
  return `${channel}|${threadTs ?? ""}`;
}

export function userOf(event: MessageEvent): string | null {
  if ("user" in event && event.user) return event.user;
  if ("bot_id" in event && event.bot_id) return event.bot_id;
  return null;
}

export function textOf(event: MessageEvent): string {
  return ("text" in event ? event.text : undefined) ?? "";
}

export function threadOf(event: MessageEvent): string {
  return ("thread_ts" in event ? event.thread_ts : undefined) ?? event.ts;
}

export class Inbox {
  private seq = 0;
  readonly convos = new Map<string, Conversation>();

  push(event: MessageEvent, direct: boolean): Conversation {
    const threadTs = threadOf(event);
    const key = convoKey(event.channel, threadTs);
    let convo = this.convos.get(key);
    if (!convo) {
      convo = { channel: event.channel, threadTs, heard: [], wakeWhy: null };
      this.convos.set(key, convo);
    }
    convo.heard.push({ event, direct, judged: direct, seq: ++this.seq });
    return convo;
  }

  get tail(): number {
    return this.seq;
  }

  pending(): Conversation[] {
    return [...this.convos.values()];
  }

  unjudged(): Conversation[] {
    return this.pending().filter((convo) => convo.heard.some((heard) => !heard.judged));
  }

  arrivedAfter(convo: Conversation, seq: number): boolean {
    return convo.heard.some((heard) => heard.direct && heard.seq > seq);
  }

  take(convos: Conversation[]): void {
    for (const convo of convos) this.convos.delete(convoKey(convo.channel, convo.threadTs));
  }
}
