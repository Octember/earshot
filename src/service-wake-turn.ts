import { wakeWhyOf } from "./ledger/conversations-judgment";
import { renderConversation } from "./ledger/conversations-render";
import { convoKey, stanceOf, type PendingConversation } from "./ledger/conversations-stance";
import { makeRefTable, type RefTable } from "./ledger/conversations-refs";
import type { AttentionItem, Event, TurnStatus } from "./ledger/schema";
import { buildToolset } from "./turn-runner/toolset";
import type { Service } from "./service";
import {
  flushBufferedReply,
  postToolsetReply,
  reactInWake,
  type WakePostContext,
} from "./service-wake-post";
import { directConvoKeys, type WakeRunState } from "./service-wake-types";
import { REF_LEGEND, append, listedSection, refVenueLine } from "./prompt/format";
import { openItems } from "./ledger/attention";
import { peekDrafts } from "./ledger/conversations-acts";
import { runTurn } from "./turn-runner/turn";
import type { AgentEvent } from "@bevyl-ai/agent-tools";
import type { IdentityConfig } from "./policy/schema";
import { isDirectAddress } from "./ledger/inbox";

function buildWakePrompt(
  host: Service,
  identityId: string,
  convos: PendingConversation[],
  refs: RefTable,
): { prompt: string; heldDrafts: ReturnType<typeof peekDrafts> } {
  const rendered = convos
    .map((convo) =>
      renderConversation(host.d.db, identityId, convo, {
        newMessages: convo.messages,
        mark: (message) => (isDirectAddress(message) ? "· you " : ""),
        wakeWhy: wakeWhyOf(host.d.db, identityId, convo),
        stance: convo.stance,
        selfLabel: "you",
        beforeRowid: convo.messages[0]!.rowid - 1,
        refs,
      }),
    )
    .join("\n\n");
  const heldDrafts = peekDrafts(host.d.db, identityId);
  const prompt = append(
    rendered ? REF_LEGEND + rendered : rendered,
    listedSection("Unsent", heldDrafts, (draft) => refVenueLine(refs, draft, draft.text)),
    renderOwedSection(refs, openItems(host.d.db, identityId), Date.parse(host.d.clock())),
  );
  return { prompt, heldDrafts };
}

export async function runResidentAttempts(
  state: WakeRunState,
): Promise<{ status: TurnStatus; failureCause: string }> {
  const { host, identityId, prompt, postCtx } = state;
  const turns = host.policy().turns;
  const flushBuffered = async (turnStatus: TurnStatus) => {
    const toFlush = state.buffered.splice(0);
    if (turnStatus !== "succeeded") return;
    for (const pendingReply of toFlush)
      await flushBufferedReply(
        postCtx,
        state.batchTail,
        pendingReply.anchor,
        pendingReply.text,
        pendingReply.awaitingReply,
      );
  };
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
    const obligationsMet =
      postCtx.effects.length > 0 &&
      (state.direct.length === 0 ||
        [...directConvoKeys(state.direct)].every((key) => postCtx.answeredConvos.has(key)));
    if (obligationsMet) {
      host.log.info("resident wake delivered outward effects — treating as success", {
        identityId,
        attempt,
        priorStatus: status,
        effects: postCtx.effects.length,
      });
      status = "succeeded";
      break;
    }
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

// Asks this wake left unanswered settle by what still carries them (an answer settled its own).
export function prepareWakeRun(
  host: Service,
  identityId: string,
  identity: IdentityConfig,
  convos: PendingConversation[],
  pending: Event[],
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
    refs,
    heldDrafts,
    prompt,
  };
}

function renderOwedSection(refs: RefTable, owed: readonly AttentionItem[], nowMs: number): string {
  return listedSection(
    "Open",
    owed,
    (item) =>
      refVenueLine(
        refs,
        item,
        item.what,
        nowMs - Date.parse(item.openedAt) > 48 * 60 * 60 * 1000 ? " · stale" : "",
      ),
    {
      cap: 5,
      overflow: (hidden) => `(+${hidden} more)`,
    },
  );
}

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

function buildResidentToolset(state: WakeRunState): ReturnType<typeof buildToolset> {
  const { host, identityId, identity, wakeId, postCtx, buffered, refs, gatingMsg } = state;
  const directConvos = directConvoKeys(state.direct);
  return buildToolset({
    db: host.d.db,
    clock: host.d.clock,
    identity,
    turnKind: "resident",
    catalog: host.catalog,
    anchor: null,
    principal: gatingMsg.principalId ? { id: gatingMsg.principalId } : undefined,
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
    bufferReply: (anchor, text, awaitingReply) => {
      if (directConvos.has(convoKey(anchor.venueId, anchor.threadRootId))) return false;
      buffered.push({ anchor, text, ...(awaitingReply ? { awaitingReply } : {}) });
      return true;
    },
    recentCharBudget: host.policy().memory.recentCharBudget,
  });
}
