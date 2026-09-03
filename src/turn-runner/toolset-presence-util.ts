import type { Anchor } from "../ledger/tasks-types";
import { engage } from "../ledger/conversations-stance";
import { checkPostingScope, pushEffect, type ToolsetContext } from "./toolset-types";
import type { RefTarget } from "../ledger/conversations-refs";
import type { ToolResult } from "../schemas/tool";

const HARNESS_TOKENS = [
  "requires_confirmation:",
  "posting_scope_violation",
  "not_available_for_turn_kind",
  "interactive_consequential_denied",
  "Requesting confirmation to call",
  "queued — it posts when your turn ends",
];

export function resolveRefTarget(
  ctx: ToolsetContext,
  ref: string | undefined,
  missing: string,
): ToolResult | { target: RefTarget } {
  const target = ref ? ctx.refs?.get(ref) : undefined;
  if (!target) return { success: false, output: missing.replace("$ref", ref ?? "") };
  return { target };
}

export function scopeViolation(ctx: ToolsetContext, anchor: Anchor): ToolResult | null {
  const violation = checkPostingScope(ctx, anchor);
  return violation ? { success: false, output: `posting_scope_violation: ${violation}` } : null;
}

export function leakedHarnessToken(text: string): string | undefined {
  return HARNESS_TOKENS.find((tok) => text.includes(tok));
}

export async function deliverReply(
  ctx: ToolsetContext,
  anchor: Anchor,
  text: string,
  awaitingReply?: boolean,
): Promise<ToolResult> {
  const result = await ctx.postMessage(anchor, text, { awaitingReply });
  if (result.messageId === "undelivered") {
    return {
      success: false,
      output: "that didn't send — the surface rejected it after retries. try again, or let it go",
    };
  }
  if (result.messageId === "already-landed") {
    return {
      success: true,
      output:
        "already posted — the room has these exact words from moments ago; nothing sent twice",
    };
  }
  if (result.messageId === "already-sent-this-wake") {
    return { success: true, output: "posted" };
  }
  engage(
    ctx.db,
    ctx.clock,
    ctx.identity.id,
    anchor.venueId,
    anchor.threadRootId ?? result.messageId,
  );
  pushEffect(ctx, { kind: "posted", anchor, text });
  return { success: true, output: "posted" };
}
