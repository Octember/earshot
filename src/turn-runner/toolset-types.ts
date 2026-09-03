import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import type { Anchor } from "../ledger/tasks-types";
import type { RefTable } from "../ledger/conversations-refs";
import type { ToolCatalog, TurnKind } from "../policy/broker";
import type { IdentityConfig } from "../policy/schema";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { gateToolCall } from "./toolset-gate";
import type { TurnEffect } from "../schemas/effects";

export interface ToolsetContext {
  db: Database;
  clock: Clock;
  identity: IdentityConfig;
  turnKind: TurnKind;
  catalog: ToolCatalog;
  // Resident turns: no batch-level anchor — every destination is a ref.
  anchor: Anchor | null;
  principal?: { id: string } | undefined;
  originEventId?: string | undefined;
  taskId?: string | undefined; // the task this execution_step turn belongs to
  outwardScopeId?: string | undefined; // outward-call dedupe scope for taskless turns (the wake id)
  nudgeAfterMs: number;
  postMessage: (
    anchor: Anchor,
    text: string,
    opts?: { awaitingReply?: boolean | undefined },
  ) => Promise<{ messageId: string }>;
  // §5.5 stale-reply withholding: set when batch had no direct address; true = buffered.
  bufferReply?: ((anchor: Anchor, text: string, awaitingReply?: boolean) => boolean) | undefined;
  // Ref table is the only speakable targets; via='search' refs bounce once with the card.
  refs?: RefTable | undefined;
  renderConversationCard?:
    | ((target: { venueId: string; threadRootId: string | null }) => string)
    | undefined;
  // React by venue + surface ts; threadRootId from the shown line, never re-derived from the batch.
  reactTo?:
    | ((
        venueId: string,
        messageId: string,
        emoji: string,
        threadRootId: string | null,
      ) => Promise<void>)
    | undefined;
  // Surface permalink for search-hit receipts; absent → cite venue + timestamp only.
  permalink?: ((venueId: string, messageId: string) => string | undefined) | undefined;
  effects: TurnEffect[]; // mutated in place — collected for turns.ts's recordTurn
  // When set, memory_write/memory_tier into recent arms distillation if over this budget.
  recentCharBudget?: number | undefined;
}

export function pushEffect(ctx: ToolsetContext, effect: TurnEffect): void {
  ctx.effects.push(effect);
}

export function checkPostingScope(ctx: ToolsetContext, anchor: Anchor): string | null {
  // Resident: any venue this identity serves; execution_step: pinned to task home venue.
  if (ctx.turnKind === "resident") {
    const venues = ctx.identity.venueIds;
    return venues.includes("*") || venues.includes(anchor.venueId)
      ? null
      : `you may only post to venues you serve, got ${anchor.venueId}`;
  }
  if (!ctx.anchor) return "no anchor context for this turn";
  return anchor.venueId === ctx.anchor.venueId
    ? null
    : `turns may only post within venue ${ctx.anchor.venueId}, got ${anchor.venueId}`;
}

// §5.1: every outbound post engages the conversation (top-level post's id becomes thread root).
export function gated(
  ctx: ToolsetContext,
  toolName: string,
  impl: (args: unknown) => Promise<{ success: boolean; output: string }>,
): DynamicTool["run"] {
  return (args) => gateToolCall(ctx, toolName, args, impl);
}
