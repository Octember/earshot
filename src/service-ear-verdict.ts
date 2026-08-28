import { openAttentionItem, closeAttentionItem, reopenAttentionItem } from "./ledger/attention";
import { recordHold, recordWakeWhy } from "./ledger/conversations";
import type { RefTable } from "./ledger/conversations";
import { parseToolArgs, zodInputSchema } from "./schemas/tool";
import { VerdictArgsSchema } from "./schemas/tools";
import type { DynamicTool } from "./turn-runner/types";
import type { ServiceHost } from "./service-util";

export type VerdictCtx = {
  host: ServiceHost;
  identityId: string;
  refs: RefTable;
  effects: unknown[];
  setNeedWake: () => void;
};

function applyHoldVerdict(
  ctx: VerdictCtx,
  venueId: string | undefined,
  root: string | null,
  why: string,
): void {
  if (venueId) recordHold(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, venueId, root, why);
}

function applyWakeVerdict(
  ctx: VerdictCtx,
  venueId: string | undefined,
  root: string | null,
  why: string,
): void {
  ctx.setNeedWake();
  if (venueId) recordWakeWhy(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, venueId, root, why);
}

function applyOpenAskVerdict(
  ctx: VerdictCtx,
  target: NonNullable<ReturnType<RefTable["get"]>>,
  venueId: string,
  why: string,
): { ok: true } | { ok: false; output: string } {
  openAttentionItem(ctx.host.d.db, ctx.host.d.clock, {
    id: ctx.host.d.newId(),
    identityId: ctx.identityId,
    venueId,
    threadRootId: target.threadRootId ?? target.ts ?? null,
    askTs: target.ts ?? null,
    what: why,
  });
  return { ok: true };
}

function applyCloseAskVerdict(
  ctx: VerdictCtx,
  itemId: string | undefined,
  why: string,
): { ok: true } | { ok: false; output: string } {
  if (
    !itemId ||
    !closeAttentionItem(ctx.host.d.db, ctx.host.d.clock, ctx.identityId, itemId, why)
  ) {
    return { ok: false, output: "no open item with that id" };
  }
  return { ok: true };
}

function applyReopenAskVerdict(
  ctx: VerdictCtx,
  itemId: string | undefined,
): { ok: true } | { ok: false; output: string } {
  if (!itemId || !reopenAttentionItem(ctx.host.d.db, ctx.identityId, itemId)) {
    return {
      ok: false,
      output:
        "nothing to reopen with that id: either it does not exist, or the operator settled it and that stays settled",
    };
  }
  return { ok: true };
}

function runVerdictDecision(
  ctx: VerdictCtx,
  decision: string,
  why: string,
  target: ReturnType<RefTable["get"]>,
  itemId: string | undefined,
): { ok: true } | { ok: false; output: string } {
  const venueId = target?.venueId;
  const residenceRoot = target ? target.threadRootId : null;
  ctx.effects.push({
    kind: "ear_verdict",
    decision,
    why,
    venueId,
    threadRootId: residenceRoot,
  });
  switch (decision) {
    case "hold":
      applyHoldVerdict(ctx, venueId, residenceRoot, why);
      return { ok: true };
    case "wake":
      applyWakeVerdict(ctx, venueId, residenceRoot, why);
      return { ok: true };
    case "open_ask":
      if (!target || !venueId) {
        return {
          ok: false,
          output:
            "open_ask needs ref — the [rN] tag of the ask itself (the message line), so the debt roots where its answer will land",
        };
      }
      return applyOpenAskVerdict(ctx, target, venueId, why);
    case "close_ask":
      return applyCloseAskVerdict(ctx, itemId, why);
    case "reopen_ask":
      return applyReopenAskVerdict(ctx, itemId);
    default:
      return { ok: false, output: `unknown decision: ${decision}` };
  }
}

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
      if (ref && !target) {
        return {
          success: false,
          output: `"${ref}" is not a ref — copy the [rN] tag (like r3) from the start of the line you are judging; timestamps and channel ids are labels, not addresses`,
        };
      }
      if ((decision === "hold" || decision === "wake") && !target) {
        return {
          success: false,
          output: `${decision} needs ref — the [rN] tag of a line in the conversation being judged, so the judgment lands on its row`,
        };
      }
      const outcome = runVerdictDecision(ctx, decision, why, target, itemId);
      return outcome.ok
        ? { success: true, output: "noted" }
        : { success: false, output: outcome.output };
    },
  };
}
