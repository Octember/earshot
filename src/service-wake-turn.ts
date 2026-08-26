import {
  consumeJudgment,
  getConversationJudgment,
  renderConversation,
  peekDrafts,
  markDraftsConsumed,
  makeRefTable,
} from "./ledger/conversations";
import type { PendingConversation } from "./ledger/conversations-stance";
import type { InboxMessage } from "./ledger/inbox";
import type { TurnStatus } from "./ledger/turns";
import { runTurn } from "./turn-runner/turn";
import type { AgentEvent } from "./turn-runner/types";
import type { IdentityConfig } from "./policy/schema";
import { isDirectAddress, type ServiceHost } from "./service-util";
import type { WakePostContext } from "./service-wake-post";
import { appendWakePromptSections } from "./service-wake-prompt";
import { buildResidentToolset, makeFlushBuffered } from "./service-wake-toolset";
import type { WakeRunState } from "./service-wake-types";

export type { WakeRunState } from "./service-wake-types";

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
        mark: (message) => (isDirectAddress(message) ? "· you " : ""),
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

export function buildWakePrompt(
  host: ServiceHost,
  identityId: string,
  convos: PendingConversation[],
  refs: ReturnType<typeof makeRefTable>,
): { prompt: string; heldDrafts: ReturnType<typeof peekDrafts> } {
  return appendWakePromptSections(
    host,
    identityId,
    renderPendingConvos(host, identityId, convos, refs),
    refs,
  );
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
