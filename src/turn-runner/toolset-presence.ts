import type { Anchor } from "../ledger/tasks-types";
import { stepBack } from "../ledger/conversations-stance";
import type { ToolsetContext } from "./toolset-types";
import { conversationOf, type RefTarget } from "../ledger/conversations-refs";
import { defineTool, zodInputSchema, type ToolResult } from "../schemas/tool";
import { getTask } from "../ledger/tasks-query";
import { transition } from "../ledger/tasks-transition";
import { closeAttentionItemsForThread } from "../ledger/attention";
import { z } from "zod";
import {
  ReactArgsSchema,
  ReplyArgsSchema,
  SetWakeArgsSchema,
  StepBackArgsSchema,
} from "../schemas/tools";
import type { DynamicTool } from "@bevyl-ai/agent-tools";

const LooseRef = { ref: z.string().optional() };

export function replyTool(ctx: ToolsetContext): DynamicTool {
  const bounced = new Set<string>();
  return defineTool(
    "reply",
    "Post a message into a conversation. ref is the [rN] tag on a New line or conversation header — not a timestamp or channel id. A message ref replies in its thread; a header ref posts at the conversation. awaiting_reply: true when your message needs an answer before you can go on.",
    ReplyArgsSchema.extend(LooseRef),
    async ({ text, ref, awaiting_reply: awaitingReply }, toolCtx) => {
      const resolved = resolveRefTarget(
        toolCtx,
        ref,
        `"${ref}" is not a ref — copy the [rN] tag (like r3) from the start of a line you were shown; timestamps and channel ids are labels, not addresses`,
      );
      if ("success" in resolved) return resolved;
      const anchor = conversationOf(resolved.target);
      const blocked = scopeViolation(toolCtx, anchor);
      if (blocked) return blocked;
      if (
        resolved.target.via === "search" &&
        toolCtx.renderConversationCard &&
        ref &&
        !bounced.has(ref)
      ) {
        bounced.add(ref);
        const card = toolCtx.renderConversationCard(conversationOf(resolved.target));
        return {
          success: false,
          output: `not sent — you haven't read this conversation this turn:\n${card}\nif your reply still holds against all of that, send it again and it goes through.`,
        };
      }
      const leaked = HARNESS_TOKENS.find((tok) => text.includes(tok));
      if (leaked) {
        return {
          success: false,
          output: `that reads like my own internal scaffolding ("${leaked}") — say it in your words instead`,
        };
      }
      if (toolCtx.bufferReply?.(anchor, text, awaitingReply)) {
        return {
          success: true,
          output:
            "queued — it posts when your turn ends, unless the conversation has moved by then (it would come back to you next time instead)",
        };
      }
      return deliverReply(toolCtx, anchor, text, awaitingReply);
    },
    zodInputSchema(ReplyArgsSchema),
  )(ctx);
}

export function reactTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "react",
    "Add an emoji reaction to a message. Input: { emoji, ref } — emoji name without colons; ref is the [rN] tag on a New line (not the conversation header).",
    ReactArgsSchema.extend(LooseRef),
    async ({ emoji: rawEmoji, ref }, toolCtx) => {
      const emoji = rawEmoji.replaceAll(":", "").trim();
      if (!emoji) return { success: false, output: "empty emoji name" };
      const resolved = resolveRefTarget(
        toolCtx,
        ref,
        "no such message ref — reactions land on a MESSAGE's [rN] tag, not a conversation's",
      );
      if ("success" in resolved) return resolved;
      if (!resolved.target.ts) {
        return {
          success: false,
          output:
            "no such message ref — reactions land on a MESSAGE's [rN] tag, not a conversation's",
        };
      }
      if (!toolCtx.reactTo) return { success: false, output: "this turn cannot react" };
      const blocked = scopeViolation(toolCtx, {
        venueId: resolved.target.venueId,
        threadRootId: null,
      });
      if (blocked) return blocked;
      try {
        await toolCtx.reactTo(
          resolved.target.venueId,
          resolved.target.ts,
          emoji,
          resolved.target.threadRootId,
        );
      } catch (error) {
        return {
          success: false,
          output: `reaction failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      toolCtx.effects.push({
        kind: "reacted",
        emoji,
        venueId: resolved.target.venueId,
        ts: resolved.target.ts,
      });
      return { success: true, output: `reacted :${emoji}:` };
    },
    zodInputSchema(ReactArgsSchema),
  )(ctx);
}

export function setWakeTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "set_wake",
    "Yield this execution, scheduling it to wake and resume at a future time. Input: { wakeAt } (ISO-8601).",
    SetWakeArgsSchema,
    async ({ wakeAt: wakeAtRaw }, toolCtx) => {
      if (!toolCtx.taskId) {
        return { success: false, output: "set_wake is only available to an execution's own turns" };
      }
      const live = getTask(toolCtx.db, toolCtx.taskId);
      if (live && live.status !== "active") {
        return {
          success: false,
          output: "this task is paused waiting on a human go-ahead — stop here and end the turn",
        };
      }
      const parsed = Date.parse(wakeAtRaw);
      if (Number.isNaN(parsed))
        return { success: false, output: "wakeAt must be an ISO-8601 timestamp" };
      const now = Date.parse(toolCtx.clock());
      if (parsed <= now)
        return { success: false, output: "wakeAt is in the past — pick a future time" };
      const wakeAt = new Date(Math.min(parsed, now + 90 * 24 * 60 * 60 * 1000)).toISOString();
      transition(toolCtx.db, toolCtx.clock, toolCtx.taskId, {
        type: "yield_timer",
        wakeAt,
      });
      toolCtx.effects.push({ kind: "yielded_timer", taskId: toolCtx.taskId, wakeAt });
      return { success: true, output: `task ${toolCtx.taskId} yielded until ${wakeAt}` };
    },
  )(ctx);
}

export function stepBackTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "step_back",
    "Leave a conversation: replies there stop being yours to answer (and stop reaching you) until someone mentions you there again, or you post there again; anything you still owed there is dropped with it. Input: { why, ref } — the conversation's (or any of its messages') [rN] tag. Use when the humans have it between them, or when someone asks you to stop.",
    StepBackArgsSchema,
    async ({ why, ref }, toolCtx) => {
      const resolved = resolveRefTarget(
        toolCtx,
        ref,
        "no such ref — step back using an [rN] tag from the conversation you're leaving",
      );
      if ("success" in resolved) return resolved;
      const key = conversationOf(resolved.target);
      stepBack(toolCtx.db, toolCtx.clock, toolCtx.identity.id, key.venueId, key.threadRootId, why);
      closeAttentionItemsForThread(
        toolCtx.db,
        toolCtx.clock,
        toolCtx.identity.id,
        key.venueId,
        key.threadRootId,
        "stepped back",
      );
      toolCtx.effects.push({
        kind: "stepped_back",
        venueId: key.venueId,
        threadRootId: key.threadRootId,
        why,
      });
      return { success: true, output: "stepped back — a mention brings you back in" };
    },
  )(ctx);
}

const HARNESS_TOKENS = [
  "requires_confirmation:",
  "posting_scope_violation",
  "not_available_for_turn_kind",
  "interactive_consequential_denied",
  "Requesting confirmation to call",
  "queued — it posts when your turn ends",
];

function resolveRefTarget(
  ctx: ToolsetContext,
  ref: string | undefined,
  missing: string,
): ToolResult | { target: RefTarget } {
  const target = ref ? ctx.refs?.get(ref) : undefined;
  if (!target) return { success: false, output: missing };
  return { target };
}

function scopeViolation(ctx: ToolsetContext, anchor: Anchor): ToolResult | null {
  let violation: string | null;
  if (ctx.turnKind === "resident") {
    const venues = ctx.identity.venueIds;
    violation =
      venues.includes("*") || venues.includes(anchor.venueId)
        ? null
        : `you may only post to venues you serve, got ${anchor.venueId}`;
  } else if (!ctx.anchor) violation = "no anchor context for this turn";
  else
    violation =
      anchor.venueId === ctx.anchor.venueId
        ? null
        : `turns may only post within venue ${ctx.anchor.venueId}, got ${anchor.venueId}`;
  return violation ? { success: false, output: `posting_scope_violation: ${violation}` } : null;
}

async function deliverReply(
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
  return { success: true, output: "posted" };
}
