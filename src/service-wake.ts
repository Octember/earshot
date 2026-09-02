import {
  pendingConversations,
  hasUndelivered,
  openDirectAsk,
  convoKey,
} from "./ledger/conversations";
import type { TurnStatus } from "./ledger/turns";
import type { ServiceHost } from "./service-util";
import {
  createReplyStreams,
  settleReplyStreams,
  type OpenAsk,
  type WakePostContext,
} from "./service-wake-post";
import { postFailureFallbacks } from "./service-wake-fallback";
import {
  prepareWakeRun,
  runResidentAttempts,
  deliverWakeConversations,
  consumeHeldDrafts,
  closeUnsettledSessions,
} from "./service-wake-turn";

export function scheduleWake(host: ServiceHost, identityId: string, delayMs: number): void {
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

export function runWake(host: ServiceHost, identityId: string): void {
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
      await settleReplyStreams(streams.values());
      deliverWakeConversations(state);
      consumeHeldDrafts(state, status);
      closeUnsettledSessions(state);
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
