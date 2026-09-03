import type { Event } from "./ledger/schema";
import type { Anchor } from "./ledger/tasks-types";
import { pendingConversations, hasUndelivered } from "./ledger/conversations-delivery";
import { markDraftsConsumed } from "./ledger/conversations-acts";
import { openDirectAsk } from "./ledger/conversations-acts";
import { convoKey } from "./ledger/conversations-stance";
import type { TurnStatus } from "./ledger/schema";
import type { Service } from "./service";
import {
  createReplyStreams,
  postFallbackReply,
  settleSession,
  type OpenAsk,
  type WakePostContext,
} from "./service-wake-post";
import { prepareWakeRun, runResidentAttempts, deliverWakeConversations } from "./service-wake-turn";

export function scheduleWake(host: Service, identityId: string, delayMs: number): void {
  if (host.stopping) return;
  if (delayMs <= 0) {
    const prior = host.residentDebounce.get(identityId);
    if (prior) {
      clearTimeout(prior);
      host.residentDebounce.delete(identityId);
    }
    runWake(host, identityId);
    return;
  }
  if (host.residentDebounce.has(identityId)) return;
  host.residentDebounce.set(
    identityId,
    setTimeout(() => {
      host.residentDebounce.delete(identityId);
      if (!host.stopping) runWake(host, identityId);
    }, delayMs),
  );
}

export function runWake(host: Service, identityId: string): void {
  if (host.residentRunning.has(identityId)) {
    host.residentRerun.add(identityId);
    return;
  }
  host.residentRunning.add(identityId);
  const promise = (async () => {
    const identity = host.identityById(identityId);
    if (!identity) return;
    const convos = pendingConversations(host.d.db, identityId);
    if (convos.length === 0) return;

    const pending = convos.flatMap((convo) => convo.messages).toSorted((a, b) => a.rowid - b.rowid);
    const wakeId = host.d.newId();
    const { streamFor, streams } = createReplyStreams(host, pending);
    const openAsks = new Map<string, OpenAsk>();
    for (const convo of convos) {
      const ask = openDirectAsk(host.d.db, identityId, convo.venueId, convo.threadRootId);
      if (ask) {
        openAsks.set(convoKey(convo.venueId, convo.threadRootId), {
          venueId: convo.venueId,
          threadRootId: convo.threadRootId,
          threadTs: ask.threadTs,
        });
      }
    }
    const postCtx: WakePostContext = {
      host,
      identityId,
      wakeId,
      effects: [],
      answeredConvos: new Set(),
      openAsks,
      streamFor,
    };
    const state = prepareWakeRun(host, identityId, identity, convos, pending, streamFor, postCtx);
    let status: TurnStatus = "failed";
    try {
      const { status: attemptStatus, failureCause } = await runResidentAttempts(state);
      status = attemptStatus;
      await postFailureFallbacks(
        postCtx,
        state.direct,
        postCtx.answeredConvos,
        status,
        failureCause,
      );
    } finally {
      for (const stream of streams.values()) await stream.close().catch(() => {});
      deliverWakeConversations(state);
      if (status === "succeeded" && state.heldDrafts.length > 0)
        markDraftsConsumed(
          host.d.db,
          host.d.clock,
          identityId,
          state.heldDrafts.map((draft) => draft.id),
        );
      for (const ask of postCtx.openAsks.values())
        settleSession(host, identityId, ask, "unanswered");
    }
    host.maybeTick();
  })().finally(() => {
    host.residentRunning.delete(identityId);
    const again = host.residentRerun.delete(identityId);
    if (!host.stopping && (again || hasUndelivered(host.d.db, identityId)))
      runWake(host, identityId);
  });
  host.track(host.wakes, promise);
}

async function postFailureFallbacks(
  postCtx: WakePostContext,
  direct: Event[],
  answeredConvos: Set<string>,
  status: TurnStatus,
  failureCause: string,
): Promise<void> {
  if (status === "succeeded" || direct.length === 0) return;
  const text = `can't run right now — ${failureCause || (status === "timed_out" ? "it ran out of time" : "my agent runtime failed")}. try me again, or flag the operator if it keeps up.`;
  const owedConvos = new Map<string, { anchor: Anchor; aliases: string[] }>();
  for (const message of direct) {
    const anchor: Anchor = {
      venueId: message.venueId,
      threadRootId: message.threadRootId ?? message.payload.ts ?? null,
    };
    const convoKeyStr = convoKey(anchor.venueId, anchor.threadRootId);
    if (!owedConvos.has(convoKeyStr)) {
      owedConvos.set(convoKeyStr, {
        anchor,
        aliases: [convoKeyStr, ...(message.threadRootId ? [] : [convoKey(anchor.venueId, null)])],
      });
    }
  }
  for (const { anchor, aliases } of owedConvos.values()) {
    if (aliases.some((alias) => answeredConvos.has(alias))) continue;
    await postFallbackReply(postCtx, anchor, text);
  }
}
