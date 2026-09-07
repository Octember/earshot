import type { MessageEvent } from "@slack/types";
import { singleton } from "tsyringe";

export interface Heard {
  event: MessageEvent;
  direct: boolean;
  judged: boolean;
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

@singleton()
export class Inbox {
  private readonly convos = new Map<string, Conversation>();

  push(event: MessageEvent, direct: boolean): Conversation {
    const threadTs = threadOf(event);
    const key = convoKey(event.channel, threadTs);
    const heard = { event, direct, judged: direct };
    const convo = this.convos.get(key);
    if (convo) {
      convo.heard.push(heard);
      return convo;
    }
    const fresh = { channel: event.channel, threadTs, heard: [heard], wakeWhy: null };
    this.convos.set(key, fresh);
    return fresh;
  }

  get(channel: string, threadTs: string | null): Conversation | undefined {
    return this.convos.get(convoKey(channel, threadTs));
  }

  pending(): Conversation[] {
    return [...this.convos.values()];
  }

  unjudged(): Conversation[] {
    return this.pending().filter((convo) => convo.heard.some((heard) => !heard.judged));
  }

  take(convos: Conversation[]): void {
    for (const convo of convos) this.convos.delete(convoKey(convo.channel, convo.threadTs));
  }
}
