import type { MessageEvent } from "@slack/types";
import { inject, singleton } from "tsyringe";
import { LEDGER, type Ledger } from "./ledger/db";
import { outOf } from "./ledger/stance";

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

function threadOf(event: MessageEvent): string {
  return ("thread_ts" in event ? event.thread_ts : undefined) ?? event.ts;
}

/** What each identity has heard and not yet dealt with, grouped by thread. Slack keeps the messages; this is only the queue. */
@singleton()
export class Inbox {
  seq = 0;
  private readonly convos = new Map<string, Map<string, Conversation>>();

  constructor(@inject(LEDGER) private readonly db: Ledger) {}

  push(identityId: string, event: MessageEvent, direct: boolean): Conversation {
    const threadTs = threadOf(event);
    const key = convoKey(event.channel, threadTs);
    const convos = this.byIdentity(identityId);
    let convo = convos.get(key);
    if (!convo) {
      convo = { channel: event.channel, threadTs, heard: [], wakeWhy: null };
      convos.set(key, convo);
    }
    convo.heard.push({ event, direct, judged: direct, seq: ++this.seq });
    return convo;
  }

  get(identityId: string, channel: string, threadTs: string | null): Conversation | undefined {
    return this.byIdentity(identityId).get(convoKey(channel, threadTs));
  }

  /** Everything pending, minus ambient chatter in threads she stepped back from (dropped here). */
  pending(identityId: string): Conversation[] {
    const all = [...this.byIdentity(identityId).values()];
    const dropped = all.filter(
      (convo) =>
        convo.wakeWhy === null &&
        !convo.heard.some((h) => h.direct) &&
        outOf(this.db, identityId, convo.channel, convo.threadTs) !== null,
    );
    this.take(identityId, dropped);
    return all.filter((convo) => !dropped.includes(convo));
  }

  unjudged(identityId: string): Conversation[] {
    return this.pending(identityId).filter((convo) => convo.heard.some((heard) => !heard.judged));
  }

  arrivedAfter(convo: Conversation, seq: number): boolean {
    return convo.heard.some((heard) => heard.direct && heard.seq > seq);
  }

  take(identityId: string, convos: Conversation[]): void {
    const mine = this.byIdentity(identityId);
    for (const convo of convos) mine.delete(convoKey(convo.channel, convo.threadTs));
  }

  private byIdentity(identityId: string): Map<string, Conversation> {
    let convos = this.convos.get(identityId);
    if (!convos) {
      convos = new Map();
      this.convos.set(identityId, convos);
    }
    return convos;
  }
}
