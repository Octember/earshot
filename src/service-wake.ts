import type { Event, TurnStatus } from "./ledger/schema";
import type { Anchor } from "./ledger/tasks-types";
import {
  hasUndelivered,
  markDelivered,
  pendingConversations,
} from "./ledger/conversations-delivery";
import { markTasksSeen } from "./ledger/tasks-query";
import { conversationOfEvent, convoKey } from "./ledger/conversations-stance";
import type { Service } from "./service";
import { answeredKeys, postReply, type WakePostContext } from "./service-wake-post";
import { prepareWakeRun, runResidentAttempts } from "./service-wake-turn";

export async function runWake(host: Service, identityId: string): Promise<void> {
  const identity = host.identityById(identityId);
  if (!identity) return;
  const convos = pendingConversations(host.d.db, host.d.clock, identityId);
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
    const answered = answeredKeys(postCtx);
    for (const message of state.direct) {
      if (message.addressMode === "thread_follow") continue;
      const home = conversationOfEvent(message);
      if (!home.threadRootId) continue;
      void host.d.adapter
        .setSessionStatus(
          home.venueId,
          home.threadRootId,
          answered.has(convoKey(home.venueId, home.threadRootId)) ? "active" : "closed",
        )
        .catch(() => {});
    }
    markDelivered(host.d.db, host.d.clock, state.convos);
    if (status === "succeeded") markTasksSeen(host.d.db, state.taskUpdates);
  }
  host.maybeTick();
  if (hasUndelivered(host.d.db, identityId)) host.resident.schedule(identityId, 0);
}

async function postFailureFallbacks(
  postCtx: WakePostContext,
  direct: Event[],
  status: TurnStatus,
  failureCause: string,
): Promise<void> {
  if (status === "succeeded" || direct.length === 0) return;
  const text = `can't run right now — ${failureCause || (status === "timed_out" ? "it ran out of time" : "my agent runtime failed")}. try me again, or flag the operator if it keeps up.`;
  const answered = answeredKeys(postCtx);
  const owed = new Map<string, Anchor>();
  for (const message of direct) {
    const anchor = conversationOfEvent(message);
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
