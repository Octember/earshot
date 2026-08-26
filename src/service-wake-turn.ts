import { openItems } from "./ledger/attention";
import {
  consumeJudgment,
  getConversationJudgment,
  renderConversation,
  peekDrafts,
  markDraftsConsumed,
  stanceOf,
  convoKey,
  makeRefTable,
} from "./ledger/conversations";
import type { PendingConversation } from "./ledger/conversations-stance";
import type { InboxMessage } from "./ledger/inbox";
import type { Anchor } from "./ledger/tasks";
import type { TurnStatus } from "./ledger/turns";
import { runTurn } from "./turn-runner/turn";
import { buildToolset, type ToolsetContext } from "./turn-runner/toolset";
import type { AgentEvent } from "./turn-runner/types";
import type { IdentityConfig } from "./policy/schema";
import { isDirectAddress, type ServiceHost } from "./service-util";
import {
  flushBufferedReply,
  postToolsetReply,
  reactInWake,
  type WakePostContext,
} from "./service-wake-post";

const ATTENTION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const ATTENTION_PROMPT_CAP = 5;

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
  checklist: Map<string, string>;
  refs: ReturnType<typeof makeRefTable>;
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

function renderPendingConvos(
  host: ServiceHost,
  identityId: string,
  convos: PendingConversation[],
  refs: ReturnType<typeof makeRefTable>,
): string {
  return convos
    .map((convo) =>
      renderConversation(host.d.db, identityId, convo, {
        newMessages: convo.messages,
        mark: (message) => (isDirectAddress(message) ? "[to you] " : ""),
        judgment:
          getConversationJudgment(host.d.db, identityId, convo.venueId, convo.threadRootId) ??
          undefined,
        stance: convo.stance,
        selfLabel: "you",
        beforeRowid: convo.messages[0]!.rowid - 1,
        refs,
      }),
    )
    .join("\n\n");
}

function formatDraftSection(
  heldDrafts: ReturnType<typeof peekDrafts>,
  refs: ReturnType<typeof makeRefTable>,
): string {
  if (heldDrafts.length === 0) return "";
  return `\n\n[drafted last wake but not sent — the conversation had moved on; decide fresh what (if anything) to say]\n${heldDrafts.map((draft) => `- [${refs.mint({ venueId: draft.venueId, threadRootId: draft.threadRootId, via: "search" })}] to <#${draft.venueId}>${draft.threadRootId ? ` thread=${draft.threadRootId}` : ""}: ${draft.text}`).join("\n")}`;
}

function formatOwedSection(
  host: ServiceHost,
  identityId: string,
  refs: ReturnType<typeof makeRefTable>,
): string {
  const owed = openItems(host.d.db, identityId);
  if (owed.length === 0) return "";
  const lines = owed.slice(0, ATTENTION_PROMPT_CAP).map((item) => {
    const overdue = Date.parse(host.d.clock()) - Date.parse(item.openedAt) > ATTENTION_MAX_AGE_MS;
    return `- [${refs.mint({ venueId: item.venueId, threadRootId: item.threadRootId, via: "search" })}] <#${item.venueId}>${item.threadRootId ? ` thread=${item.threadRootId}` : ""}: ${item.what}${overdue ? " (open a long time — settle it or drop it)" : ""}`;
  });
  const tail =
    owed.length > ATTENTION_PROMPT_CAP
      ? `\n(+${owed.length - ATTENTION_PROMPT_CAP} newer ones not shown — they surface as these settle)`
      : "";
  return `\n\n[still owed]\n${lines.join("\n")}${tail}`;
}

export function buildWakePrompt(
  host: ServiceHost,
  identityId: string,
  convos: PendingConversation[],
  refs: ReturnType<typeof makeRefTable>,
): { prompt: string; heldDrafts: ReturnType<typeof peekDrafts> } {
  const rendered = renderPendingConvos(host, identityId, convos, refs);
  const heldDrafts = peekDrafts(host.d.db, identityId);
  return {
    prompt: `${rendered}${formatDraftSection(heldDrafts, refs)}${formatOwedSection(host, identityId, refs)}`,
    heldDrafts,
  };
}

function makeBufferReply(
  directConvos: Set<string>,
  buffered: { anchor: Anchor; text: string }[],
): ToolsetContext["bufferReply"] {
  return (anchor, text) => {
    if (directConvos.has(convoKey(anchor.venueId, anchor.threadRootId))) return false;
    buffered.push({ anchor, text });
    return true;
  };
}

function makeFlushBuffered(
  buffered: { anchor: Anchor; text: string }[],
  postCtx: WakePostContext,
  batchTail: number,
): (turnStatus: TurnStatus) => Promise<void> {
  return async (turnStatus) => {
    const toFlush = buffered.splice(0);
    if (turnStatus !== "succeeded") return;
    for (const pendingReply of toFlush) {
      await flushBufferedReply(postCtx, batchTail, pendingReply.anchor, pendingReply.text);
    }
  };
}

function renderConversationCard(
  host: ServiceHost,
  identityId: string,
  refs: ReturnType<typeof makeRefTable>,
  target: { venueId: string; threadRootId: string | null },
): string {
  return renderConversation(host.d.db, identityId, target, {
    newMessages: [],
    judgment:
      getConversationJudgment(host.d.db, identityId, target.venueId, target.threadRootId) ??
      undefined,
    stance: stanceOf(host.d.db, identityId, target.venueId, target.threadRootId),
    selfLabel: "you",
    beforeRowid: Number.MAX_SAFE_INTEGER,
    refs,
  });
}

export function buildResidentToolset(state: WakeRunState): ReturnType<typeof buildToolset> {
  const {
    host,
    identityId,
    identity,
    wakeId,
    postCtx,
    streamFor,
    buffered,
    checklist,
    refs,
    gatingMsg,
  } = state;
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
    permalink: (venueId, ts) => host.d.adapter.permalink?.(venueId, ts),
    postMessage: (anchor, text) => postToolsetReply(postCtx, anchor, text),
    updateMessage: host.d.adapter.updateMessage
      ? (venueId, messageId, text) => host.d.adapter.updateMessage!(venueId, messageId, text)
      : undefined,
    renderChecklist: async (items, seat) => streamFor(seat).setCards(items),
    reactTo: (venueId, ts, emoji, threadRootId) =>
      reactInWake(postCtx, venueId, ts, emoji, threadRootId),
    checklist,
    effects: postCtx.effects,
    refs,
    renderConversationCard: (target) => renderConversationCard(host, identityId, refs, target),
    bufferReply: makeBufferReply(directConvos, buffered),
  });
}

export type ResidentAttemptResult = {
  status: TurnStatus;
  failureCause: string;
};

export async function runResidentAttempts(state: WakeRunState): Promise<ResidentAttemptResult> {
  const { host, identityId, prompt, postCtx } = state;
  const turns = host.policy().turns;
  const flushBuffered = makeFlushBuffered(state.buffered, postCtx, state.batchTail);
  let status: TurnStatus = "failed";
  let failureCause = "";
  const onEvent = (agentEvent: AgentEvent) => {
    if (agentEvent.event === "turn_failed" && agentEvent.log) failureCause = agentEvent.log;
    if (agentEvent.log) host.log.info("codex", { line: agentEvent.log });
  };

  for (let attempt = 0; attempt <= turns.maxRetries; attempt++) {
    failureCause = "";
    const session = host.d.sessionFactory(buildResidentToolset(state), onEvent);
    try {
      await session.start(host.workspaceFor(identityId));
      const threadId = await session.startThread(host.workspaceFor(identityId));
      const result = await runTurn({
        session,
        threadId,
        cwd: host.workspaceFor(identityId),
        prompt,
        title: `resident:${identityId}`,
        db: host.d.db,
        clock: host.d.clock,
        turnId: host.d.newId(),
        identityId,
        kind: "resident",
        effects: postCtx.effects,
        tokensUsed: () => 0,
        spendAmount: () => 0,
        envelope: {
          timeoutMs: turns.interactiveTimeoutMs,
          tokenCeiling: turns.interactiveTokenCeiling,
        },
        stallTimeoutMs: turns.stallTimeoutMs,
        beforeRecord: flushBuffered,
      });
      status = result.status;
      if (!failureCause && result.cause) failureCause = result.cause;
    } catch (error) {
      status = "failed";
      failureCause = error instanceof Error ? error.message : String(error);
    } finally {
      session.stop();
    }
    if (status === "succeeded") break;
    host.log.error("resident wake attempt did not succeed", {
      identityId,
      attempt,
      status,
      cause: failureCause,
    });
    if (postCtx.effects.length > 0) break;
    if (attempt < turns.maxRetries) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, turns.backoffMs * 2 ** attempt);
      });
    }
  }
  return { status, failureCause };
}

export function consumeWakeJudgments(state: WakeRunState): void {
  for (const convo of state.convos) {
    consumeJudgment(
      state.host.d.db,
      state.host.d.clock,
      state.identityId,
      convo,
      convo.messages.at(-1)!.rowid,
    );
  }
}

export function consumeHeldDrafts(state: WakeRunState, status: TurnStatus): void {
  if (status !== "succeeded" || state.heldDrafts.length === 0) return;
  markDraftsConsumed(
    state.host.d.db,
    state.host.d.clock,
    state.identityId,
    state.heldDrafts.map((draft) => draft.id),
  );
}

export function clearDirectTyping(state: WakeRunState): void {
  for (const message of state.direct) {
    void state.host.d.adapter
      .setTypingStatus?.(message.venueId ?? "", message.threadRootId ?? message.ts ?? "", "")
      .catch(() => {});
  }
}

export function prepareWakeRun(
  host: ServiceHost,
  identityId: string,
  identity: IdentityConfig,
  convos: PendingConversation[],
  pending: InboxMessage[],
  streamFor: WakePostContext["streamFor"],
  postCtx: WakePostContext,
): WakeRunState {
  host.refreshSoul();
  const refs = makeRefTable();
  const addressed = pending.filter((message) => message.kind === "addressed_message");
  const direct = pending.filter((message) => isDirectAddress(message));
  const { prompt, heldDrafts } = buildWakePrompt(host, identityId, convos, refs);
  return {
    host,
    identityId,
    identity,
    wakeId: postCtx.wakeId,
    convos,
    direct,
    gatingMsg: addressed.at(-1) ?? pending.at(-1)!,
    batchTail: pending.at(-1)!.rowid,
    postCtx,
    streamFor,
    buffered: [],
    checklist: new Map(),
    refs,
    heldDrafts,
    prompt,
  };
}
