import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import type { Anchor } from "../ledger/tasks";
import { getTask, requestConfirmation } from "../ledger/tasks";
import { engage } from "../ledger/conversations";
import { decide, actionRefFor, type ToolCatalog, type TurnKind } from "../policy/broker";
import type { IdentityConfig } from "../policy/schema";
import type { RefTable } from "../ledger/conversations";
import type { DynamicTool } from "./types";

export interface ToolFactory {
  spec: DynamicTool["spec"];
  impl: (args: unknown) => Promise<{ success: boolean; output: string }>;
}

export interface Principal {
  id: string;
  isOperator: boolean;
}

export interface ToolsetContext {
  db: Database;
  clock: Clock;
  identity: IdentityConfig;
  turnKind: TurnKind;
  catalog: ToolCatalog;
  // Resident turns: no batch-level anchor — every destination is a ref.
  anchor: Anchor | null;
  principal?: Principal | undefined;
  originEventId?: string | undefined;
  taskId?: string | undefined; // the task this execution_step turn belongs to
  outwardScopeId?: string | undefined; // outward-call dedupe scope for taskless turns (the wake id)
  nudgeAfterMs: number;
  postMessage: (anchor: Anchor, text: string) => Promise<{ messageId: string }>;
  // §5.5 stale-reply withholding: set when batch had no direct address; true = buffered.
  bufferReply?: ((anchor: Anchor, text: string) => boolean) | undefined;
  // Ref table is the only speakable targets; via='search' refs bounce once with the card.
  refs?: RefTable | undefined;
  renderConversationCard?: ((target: { venueId: string; threadRootId: string | null }) => string) | undefined;
  updateMessage?: ((venueId: string, messageId: string, text: string) => Promise<void>) | undefined;
  checklist?: Map<string, string> | undefined;
  // React by venue + surface ts; threadRootId from the shown line, never re-derived from the batch.
  reactTo?: ((venueId: string, messageId: string, emoji: string, threadRootId: string | null) => Promise<void>) | undefined;
  renderChecklist?: ((items: { text: string; done: boolean }[], seat: Anchor) => Promise<boolean>) | undefined;
  // Resolve principal standing from a ref's provenance (not wake-level principal).
  resolvePrincipal?: ((principalId: string) => Principal) | undefined;
  // Surface permalink for search-hit receipts; absent → cite venue + timestamp only.
  permalink?: ((venueId: string, messageId: string) => string | undefined) | undefined;
  effects: unknown[]; // mutated in place — collected for turns.ts's recordTurn
}

export function pushEffect(ctx: ToolsetContext, effect: unknown): void {
  ctx.effects.push(effect);
}

export function checkPostingScope(ctx: ToolsetContext, anchor: Anchor): string | null {
  // Resident: any venue this identity serves; execution_step: pinned to task home venue.
  if (ctx.turnKind === "resident") {
    const venues = ctx.identity.venueIds;
    return venues.includes("*") || venues.includes(anchor.venueId) ? null : `you may only post to venues you serve, got ${anchor.venueId}`;
  }
  if (!ctx.anchor) return "no anchor context for this turn";
  return anchor.venueId === ctx.anchor.venueId ? null : `turns may only post within venue ${ctx.anchor.venueId}, got ${anchor.venueId}`;
}

// §5.1: every outbound post engages the conversation (top-level post's id becomes thread root).
export function recordPostedThread(ctx: ToolsetContext, anchor: Anchor, messageId: string): void {
  engage(ctx.db, ctx.clock, ctx.identity.id, anchor.venueId, anchor.threadRootId ?? messageId);
}

export function gated(ctx: ToolsetContext, toolName: string, impl: (args: unknown) => Promise<{ success: boolean; output: string }>): DynamicTool["run"] {
  return async (args: unknown) => {
    const decision = decide(ctx.db, ctx.clock, {
      identity: ctx.identity,
      turnKind: ctx.turnKind,
      tool: toolName,
      args,
      catalog: ctx.catalog,
      taskId: ctx.taskId,
    });
    if (!decision.allow) {
      // §10.2: denied consequential on execution_step → confirmation flow, not bare fail.
      if (decision.reason === "confirmation_denied") {
        return {
          success: false,
          output: "a human declined exactly this action — it stays declined. Change the approach, or task_fail with what you wanted and why it was refused.",
        };
      }
      if (decision.reason === "requires_confirmation" && ctx.taskId) {
        const current = getTask(ctx.db, ctx.taskId)?.pendingConfirmation;
        if (current?.actionRef === actionRefFor(toolName, args) && current.resolution?.approved && current.consumedAt) {
          return { success: false, output: "already done: this exact call was approved and ran earlier. If you meant a different change, change the arguments." };
        }
        if (current && !current.resolution) {
          return { success: false, output: "a go-ahead request is already pending on this task — stop here and end the turn; ask for anything else after it resolves" };
        }
        if (current?.resolution?.approved && !current.consumedAt) {
          return { success: false, output: "an approved go-ahead for another action is still unspent — execute that first (or task_fail explaining why not)" };
        }
        const nudgeDeadline = new Date(new Date(ctx.clock()).getTime() + ctx.nudgeAfterMs).toISOString();
        requestConfirmation(ctx.db, ctx.clock, {
          taskId: ctx.taskId,
          actionRef: actionRefFor(toolName, args),
          description: `Requesting confirmation to call ${toolName} (${decision.actionClasses.join(", ")}) with ${JSON.stringify(args)}`,
          nudgeDeadline,
        });
        pushEffect(ctx, { kind: "confirmation_requested", tool: toolName, actionClasses: decision.actionClasses });
        return {
          success: false,
          output: `requires_confirmation: task ${ctx.taskId} is now waiting on a human go-ahead — the request reaches the room through the mind. Stop here and end the turn; do not retry the call and do not reach for outcome tools (the task is paused until the go-ahead resolves).`,
        };
      }
      // Hand room-ready framing for turn-policy denials (avoid broker jargon in the venue).
      if (decision.reason === "not_available_for_turn_kind") {
        return {
          success: false,
          output: `denied: not_available_for_turn_kind — this turn is speak-only; the action can run from a task turn or after a member's go-ahead. If you mention this in the room, say it plainly ("say the word and i'll do it") — never turn kinds, mutations, or other internals.`,
        };
      }
      if (decision.reason === "interactive_consequential_denied") {
        return {
          success: false,
          output: `denied: interactive_consequential_denied — this action is consequential and must run inside a task: use task_create and it will proceed there. When you tell the room, say plainly what you're taking on and where you'll report back — never this machinery.`,
        };
      }
      return { success: false, output: `denied: ${decision.reason}` };
    }
    return impl(args);
  };
}
