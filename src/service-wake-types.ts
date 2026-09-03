import { peekDrafts } from "./ledger/conversations-acts";
import { convoKey } from "./ledger/conversations-stance";
import type { PendingConversation } from "./ledger/conversations-stance";
import type { Event } from "./ledger/schema";
import type { Anchor } from "./ledger/tasks-types";
import type { IdentityConfig } from "./policy/schema";
import type { RefTable } from "./ledger/conversations-refs";
import type { Service } from "./service";
import type { WakePostContext } from "./service-wake-post";

export type WakeRunState = {
  host: Service;
  identityId: string;
  identity: IdentityConfig;
  wakeId: string;
  convos: PendingConversation[];
  direct: Event[];
  gatingMsg: Event;
  batchTail: number;
  postCtx: WakePostContext;
  streamFor: WakePostContext["streamFor"];
  buffered: { anchor: Anchor; text: string; awaitingReply?: boolean }[];
  refs: RefTable;
  heldDrafts: ReturnType<typeof peekDrafts>;
  prompt: string;
};

export function directConvoKeys(direct: Event[]): Set<string> {
  return new Set(
    direct.flatMap((message) => [
      convoKey(message.venueId, message.threadRootId ?? message.payload.ts),
      ...(message.threadRootId ? [] : [convoKey(message.venueId, null)]),
    ]),
  );
}
