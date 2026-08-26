import { peekDrafts, convoKey } from "./ledger/conversations";
import type { PendingConversation } from "./ledger/conversations-stance";
import type { InboxMessage } from "./ledger/inbox";
import type { Anchor } from "./ledger/tasks";
import type { IdentityConfig } from "./policy/schema";
import type { RefTable } from "./ledger/conversations-refs";
import type { ServiceHost } from "./service-util";
import type { WakePostContext } from "./service-wake-post";

export type WakeRunState = {
  host: ServiceHost;
  identityId: string;
  identity: IdentityConfig;
  wakeId: string;
  convos: PendingConversation[];
  direct: InboxMessage[];
  gatingMsg: InboxMessage;
  batchTail: number;
  postCtx: WakePostContext;
  streamFor: WakePostContext["streamFor"];
  buffered: { anchor: Anchor; text: string }[];
  refs: RefTable;
  heldDrafts: ReturnType<typeof peekDrafts>;
  prompt: string;
};

export function directConvoKeys(direct: InboxMessage[]): Set<string> {
  return new Set(
    direct.flatMap((message) => [
      convoKey(message.venueId ?? "", message.threadRootId ?? message.ts),
      ...(message.threadRootId ? [] : [convoKey(message.venueId ?? "", null)]),
    ]),
  );
}
