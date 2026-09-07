import { singleton } from "tsyringe";

export interface Conversation {
  channel: string;
  threadTs: string;
  since: string;
  direct: boolean;
  judged: boolean;
  wakeWhy: string | null;
}

export function convoKey(channel: string, threadTs: string | null): string {
  return `${channel}|${threadTs ?? ""}`;
}

@singleton()
export class Inbox {
  private readonly convos = new Map<string, Conversation>();

  push(channel: string, threadTs: string, ts: string, direct: boolean): Conversation {
    const key = convoKey(channel, threadTs);
    const convo = this.convos.get(key);
    if (convo) {
      convo.direct ||= direct;
      convo.judged &&= direct;
      return convo;
    }
    const fresh = { channel, threadTs, since: ts, direct, judged: direct, wakeWhy: null };
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
    return this.pending().filter((convo) => !convo.judged);
  }

  take(convos: Conversation[]): void {
    for (const convo of convos) this.convos.delete(convoKey(convo.channel, convo.threadTs));
  }
}
