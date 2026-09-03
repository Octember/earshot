import { recordWakeWhy } from "./ledger/conversations-stance";
import type { RefTable } from "./ledger/conversations-refs";
import { parseToolArgs, zodInputSchema } from "./schemas/tool";
import { VerdictArgsSchema } from "./schemas/tools";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { Service } from "./service";
import type { TurnEffect } from "./schemas/effects";

export function createVerdictTool(ctx: {
  host: Service;
  identityId: string;
  refs: RefTable;
  effects: TurnEffect[];
  setNeedWake: () => void;
}): DynamicTool {
  return {
    spec: {
      name: "verdict",
      description:
        "Report one judgment about one conversation. decision: 'hold' (nothing needed from her) or 'wake' (this is HERS and needs her now — why becomes her own first read of it). ref is the [rN] tag of a line in the conversation being judged. Every why must read naturally if said aloud in the room.",
      inputSchema: zodInputSchema(VerdictArgsSchema),
    },
    run: async (args: unknown) => {
      const parsed = parseToolArgs(VerdictArgsSchema, args);
      if ("success" in parsed) return parsed;
      const { decision, why, ref } = parsed.data;
      const target = ctx.refs.get(ref);
      if (!target)
        return {
          success: false,
          output: `"${ref}" is not a ref — copy the [rN] tag (like r3) from the start of the line you are judging; timestamps and channel ids are labels, not addresses`,
        };
      ctx.effects.push({
        kind: "ear_verdict",
        decision,
        why,
        venueId: target.venueId,
        threadRootId: target.threadRootId,
      });
      if (decision === "wake") {
        ctx.setNeedWake();
        if (target.eventId) recordWakeWhy(ctx.host.d.db, target.eventId, why);
      }
      return { success: true, output: "noted" };
    },
  };
}
