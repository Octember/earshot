import { deliverConversation } from "./ledger/conversations-judgment";
import type { Event, TurnStatus } from "./ledger/schema";
import type { Anchor } from "./ledger/tasks-types";
import { hasUndelivered, pendingConversations } from "./ledger/conversations-delivery";
import { markTasksSeen } from "./ledger/tasks-query";
import { convoKey } from "./ledger/conversations-stance";
import type { Service } from "./service";
import { postReply, type WakePostContext } from "./service-wake-post";
import { prepareWakeRun, runResidentAttempts } from "./service-wake-turn";

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
    const postCtx: WakePostContext = {
      host,
      identityId,
      wakeId: host.d.newId(),
      batchTail: pending.at(-1)!.rowid,
      effects: [],
      moved: new Set(),
    };
    const state = prepareWakeRun(host, identityId, identity, convos, pending, postCtx);
    let status: TurnStatus = "failed";
    try {
      const { status: attemptStatus, failureCause } = await runResidentAttempts(state);
      status = attemptStatus;
      await postFailureFallbacks(postCtx, state.direct, status, failureCause);
    } finally {
      for (const convo of state.convos)
        deliverConversation(host.d.db, identityId, convo, convo.messages.at(-1)!.rowid);
      if (status === "succeeded") markTasksSeen(host.d.db, state.taskUpdates);
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
  status: TurnStatus,
  failureCause: string,
): Promise<void> {
  if (status === "succeeded" || direct.length === 0) return;
  const text = `can't run right now — ${failureCause || (status === "timed_out" ? "it ran out of time" : "my agent runtime failed")}. try me again, or flag the operator if it keeps up.`;
  const answered = new Set(
    postCtx.effects.flatMap((effect) =>
      effect.kind === "posted" ? [convoKey(effect.anchor.venueId, effect.anchor.threadRootId)] : [],
    ),
  );
  const owed = new Map<string, Anchor>();
  for (const message of direct) {
    const anchor: Anchor = {
      venueId: message.venueId,
      threadRootId: message.threadRootId ?? message.payload.ts ?? null,
    };
    const keys = [
      convoKey(anchor.venueId, anchor.threadRootId),
      ...(message.threadRootId ? [] : [convoKey(anchor.venueId, null)]),
    ];
    if (keys.some((key) => answered.has(key) || owed.has(key))) continue;
    owed.set(keys[0]!, anchor);
  }
  for (const anchor of owed.values()) {
    postCtx.moved.add(convoKey(anchor.venueId, anchor.threadRootId));
    await postReply(postCtx, anchor, text);
  }
}
