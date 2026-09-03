import { wakeWhyOf } from "./ledger/conversations-judgment";
import { renderConversation } from "./ledger/conversations-render";
import { stanceOf, convoKey } from "./ledger/conversations-stance";
import type { RefTable } from "./ledger/conversations-refs";
import type { TurnStatus } from "./ledger/schema";
import { buildToolset } from "./turn-runner/toolset";
import type { ToolsetContext } from "./turn-runner/toolset-types";
import type { Service } from "./service";
import {
  flushBufferedReply,
  postToolsetReply,
  reactInWake,
  type WakePostContext,
} from "./service-wake-post";
import type { WakeRunState } from "./service-wake-types";
import { directConvoKeys } from "./service-wake-types";

function renderConversationCard(
  host: Service,
  identityId: string,
  refs: RefTable,
  target: { venueId: string; threadRootId: string | null },
): string {
  return renderConversation(host.d.db, identityId, target, {
    newMessages: [],
    wakeWhy: wakeWhyOf(host.d.db, identityId, target),
    stance: stanceOf(host.d.db, identityId, target.venueId, target.threadRootId),
    selfLabel: "you",
    beforeRowid: Number.MAX_SAFE_INTEGER,
    refs,
  });
}

function makeBufferReply(
  directConvos: Set<string>,
  buffered: WakeRunState["buffered"],
): ToolsetContext["bufferReply"] {
  return (anchor, text, awaitingReply) => {
    if (directConvos.has(convoKey(anchor.venueId, anchor.threadRootId))) return false;
    buffered.push({ anchor, text, ...(awaitingReply ? { awaitingReply } : {}) });
    return true;
  };
}

export function makeFlushBuffered(
  buffered: WakeRunState["buffered"],
  postCtx: WakePostContext,
  batchTail: number,
): (turnStatus: TurnStatus) => Promise<void> {
  return async (turnStatus) => {
    const toFlush = buffered.splice(0);
    if (turnStatus !== "succeeded") return;
    for (const pendingReply of toFlush) {
      await flushBufferedReply(
        postCtx,
        batchTail,
        pendingReply.anchor,
        pendingReply.text,
        pendingReply.awaitingReply,
      );
    }
  };
}

export function buildResidentToolset(state: WakeRunState): ReturnType<typeof buildToolset> {
  const { host, identityId, identity, wakeId, postCtx, buffered, refs, gatingMsg } = state;
  const directConvos = directConvoKeys(state.direct);
  return buildToolset({
    db: host.d.db,
    clock: host.d.clock,
    identity,
    turnKind: "resident",
    catalog: host.catalog,
    anchor: null,
    principal: host.principalOf(gatingMsg.principalId),
    resolvePrincipal: (id) => host.principalOf(id),
    nudgeAfterMs: host.policy().tasks.nudgeAfterMs,
    outwardScopeId: wakeId,
    permalink: (venueId, ts) => host.d.adapter.permalink(venueId, ts),
    postMessage: (anchor, text, opts) =>
      postToolsetReply(postCtx, anchor, text, opts?.awaitingReply),
    reactTo: (venueId, ts, emoji, threadRootId) =>
      reactInWake(postCtx, venueId, ts, emoji, threadRootId),
    effects: postCtx.effects,
    refs,
    renderConversationCard: (target) => renderConversationCard(host, identityId, refs, target),
    bufferReply: makeBufferReply(directConvos, buffered),
    recentCharBudget: host.policy().memory.recentCharBudget,
  });
}
