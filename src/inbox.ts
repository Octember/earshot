import type { MessageElement } from "@slack/web-api/dist/types/response/ConversationsRepliesResponse";
import { singleton } from "tsyringe";
import type { Attachment } from "./attachments";

export type Message = Pick<MessageElement, "user" | "bot_id" | "text" | "ts" | "thread_ts"> & {
  files?: Attachment[] | undefined;
};

export interface Heard {
  message: Message;
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

@singleton()
export class Inbox {
  private readonly convos = new Map<string, Conversation>();

  push(channel: string, threadTs: string, message: Message, direct: boolean): Conversation {
    const key = convoKey(channel, threadTs);
    const heard = { message, direct, judged: direct };
    const convo = this.convos.get(key);
    if (convo) {
      convo.heard.push(heard);
      return convo;
    }
    const fresh = { channel, threadTs, heard: [heard], wakeWhy: null };
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
