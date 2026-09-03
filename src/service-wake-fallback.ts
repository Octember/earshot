import { convoKey } from "./ledger/conversations-stance";
import type { Event } from "./ledger/schema";
import type { Anchor } from "./ledger/tasks-types";
import type { TurnStatus } from "./ledger/schema";
import { postFallbackReply, type WakePostContext } from "./service-wake-post";

export async function postFailureFallbacks(
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
