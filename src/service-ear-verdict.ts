import { openAttentionItem, closeAttentionItem, reopenAttentionItem } from "./ledger/attention";
import { recordWakeWhy } from "./ledger/conversations-stance";
import type { RefTable } from "./ledger/conversations-refs";
import { parseToolArgs, zodInputSchema } from "./schemas/tool";
import { VerdictArgsSchema } from "./schemas/tools";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { Service } from "./service";
import type { TurnEffect } from "./schemas/effects";

type VerdictCtx = {
  host: Service;
  identityId: string;
  refs: RefTable;
  effects: TurnEffect[];
  setNeedWake: () => void;
};

export function createVerdictTool(ctx: VerdictCtx): DynamicTool {
  return {
    spec: {
      name: "verdict",
      description:
        "Report one judgment about one conversation. decision: 'hold' (nothing needed from her), 'wake' (this is HERS and needs her now — why becomes her own first read of it), 'open_ask' (a direct ask of her, never what one teammate owes another — record the debt; does not wake by itself), 'close_ask' / 'reopen_ask' (a recorded debt was settled / was not actually settled; pass itemId). Every why must read naturally if said aloud in the room.",
      inputSchema: zodInputSchema(VerdictArgsSchema),
    },
    run: async (args: unknown) => {
      const parsed = parseToolArgs(VerdictArgsSchema, args);
      if ("success" in parsed) return parsed;
      const { decision, why, ref, itemId } = parsed.data;
      const target = ref ? ctx.refs.get(ref) : undefined;
      if (ref && !target)
        return {
          success: false,
          output: `"${ref}" is not a ref — copy the [rN] tag (like r3) from the start of the line you are judging; timestamps and channel ids are labels, not addresses`,
        };
      if ((decision === "hold" || decision === "wake") && !target)
        return {
          success: false,
          output: `${decision} needs ref — the [rN] tag of a line in the conversation being judged, so the judgment lands on its row`,
        };
      const venueId = target?.venueId;
      const residenceRoot = target ? target.threadRootId : null;
      ctx.effects.push({
        kind: "ear_verdict",
        decision,
        why,
        venueId,
        threadRootId: residenceRoot,
      });
      const { db, clock } = ctx.host.d;
      if (decision === "wake") {
        ctx.setNeedWake();
        if (venueId) recordWakeWhy(db, clock, ctx.identityId, venueId, residenceRoot, why);
      } else if (decision === "open_ask") {
        if (!target || !venueId)
          return {
            success: false,
            output:
              "open_ask needs ref — the [rN] tag of the ask itself (the message line), so the debt roots where its answer will land",
          };
        openAttentionItem(db, clock, {
          id: ctx.host.d.newId(),
          identityId: ctx.identityId,
          venueId,
          threadRootId: target.threadRootId ?? target.ts ?? null,
          askTs: target.ts ?? null,
          what: why,
        });
      } else if (
        decision === "close_ask" &&
        (!itemId || !closeAttentionItem(db, clock, ctx.identityId, itemId, why))
      ) {
        return { success: false, output: "no open item with that id" };
      } else if (
        decision === "reopen_ask" &&
        (!itemId || !reopenAttentionItem(db, ctx.identityId, itemId))
      ) {
        return {
          success: false,
          output:
            "nothing to reopen with that id: either it does not exist, or the operator settled it and that stays settled",
        };
      }
      return { success: true, output: "noted" };
    },
  };
}
