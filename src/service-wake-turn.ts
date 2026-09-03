import { deliverConversation, wakeWhyOf } from "./ledger/conversations-judgment";
import { renderConversation } from "./ledger/conversations-render";
import { peekDrafts } from "./ledger/conversations-acts";
import { makeRefTable } from "./ledger/conversations-refs";
import type { PendingConversation } from "./ledger/conversations-stance";
import type { Event } from "./ledger/schema";
import type { TurnStatus } from "./ledger/schema";
import { runTurn } from "./turn-runner/turn";
import type { AgentEvent } from "@bevyl-ai/agent-tools";
import type { IdentityConfig } from "./policy/schema";
import { isDirectAddress } from "./ledger/inbox";
import type { Service } from "./service";
import type { WakePostContext } from "./service-wake-post";
import { appendWakePromptSections } from "./service-wake-prompt";
import { buildResidentToolset, makeFlushBuffered } from "./service-wake-toolset";
import type { WakeRunState } from "./service-wake-types";
import { directConvoKeys } from "./service-wake-types";

function renderPendingConvos(
  host: Service,
  identityId: string,
  convos: PendingConversation[],
  refs: ReturnType<typeof makeRefTable>,
): string {
  return convos
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
}

function buildWakePrompt(
  host: Service,
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

type ResidentAttemptResult = {
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

export function deliverWakeConversations(state: WakeRunState): void {
  for (const convo of state.convos) {
    deliverConversation(
      state.host.d.db,
      state.host.d.clock,
      state.identityId,
      convo,
      convo.messages.at(-1)!.rowid,
    );
  }
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
