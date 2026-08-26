import { getTask, transition } from "../ledger/tasks";
import { closeAttentionItemsForThread } from "../ledger/attention";
import { stepBack, convoKey, conversationOf } from "../ledger/conversations";
import { z } from "zod";
import { defineTool, zodInputSchema } from "../schemas/tool";
import {
  ChecklistArgsSchema,
  ReactArgsSchema,
  ReplyArgsSchema,
  SetWakeArgsSchema,
  StepBackArgsSchema,
} from "../schemas/tools";
import { pushEffect, type ToolFactory, type ToolsetContext } from "./toolset-types";
import {
  anchorForTarget,
  deliverReply,
  leakedHarnessToken,
  renderChecklistText,
  resolveRefTarget,
  scopeViolation,
} from "./toolset-presence-util";
import type { Anchor } from "../ledger/tasks";

const ReplyParseSchema = z.object({
  text: z.string(),
  ref: z.string().optional(),
});

const ReactParseSchema = z.object({
  emoji: z.string(),
  ref: z.string().optional(),
});

export function replyTool(ctx: ToolsetContext): ToolFactory {
  const bounced = new Set<string>();
  return defineTool(
    "reply",
    "Post a message into a conversation. ref is the [rN] tag on a New line or conversation header — not a timestamp or channel id. A message ref replies in its thread; a header ref posts at the conversation.",
    ReplyParseSchema,
    async ({ text, ref }, toolCtx) => {
      const resolved = resolveRefTarget(
        toolCtx,
        ref,
        `"${ref}" is not a ref — copy the [rN] tag (like r3) from the start of a line you were shown; timestamps and channel ids are labels, not addresses`,
      );
      if ("success" in resolved) return resolved;
      const anchor = anchorForTarget(resolved.target);
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
      const leaked = leakedHarnessToken(text);
      if (leaked) {
        return {
          success: false,
          output: `that reads like my own internal scaffolding ("${leaked}") — say it in your words instead`,
        };
      }
      if (toolCtx.bufferReply?.(anchor, text)) {
        return {
          success: true,
          output:
            "queued — it posts when your turn ends, unless the conversation has moved by then (it would come back to you next time instead)",
        };
      }
      return deliverReply(toolCtx, anchor, text);
    },
    zodInputSchema(ReplyArgsSchema),
  )(ctx);
}

export function reactTool(ctx: ToolsetContext): ToolFactory {
  return defineTool(
    "react",
    "Add an emoji reaction to a message. Input: { emoji, ref } — emoji name without colons; ref is the [rN] tag on a New line (not the conversation header).",
    ReactParseSchema,
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
      pushEffect(toolCtx, {
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

export function setWakeTool(ctx: ToolsetContext): ToolFactory {
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
      transition(toolCtx.db, toolCtx.clock, toolCtx.taskId, "waiting", {
        type: "yield_timer",
        wakeAt,
      });
      pushEffect(toolCtx, { kind: "yielded_timer", taskId: toolCtx.taskId, wakeAt });
      return { success: true, output: `task ${toolCtx.taskId} yielded until ${wakeAt}` };
    },
  )(ctx);
}

async function publishChecklist(
  ctx: ToolsetContext,
  seat: Anchor,
  items: { text: string; done: boolean }[],
  holder: Map<string, string>,
): Promise<{ ok: true } | { ok: false; output: string }> {
  const native = ctx.renderChecklist ? await ctx.renderChecklist(items, seat) : false;
  if (native) return { ok: true };
  const text = renderChecklistText(items);
  const seatKey = convoKey(seat.venueId, seat.threadRootId);
  const existing = holder.get(seatKey);
  if (existing && ctx.updateMessage) {
    await ctx.updateMessage(seat.venueId, existing, text);
    return { ok: true };
  }
  const result = await ctx.postMessage(seat, text);
  if (
    result.messageId === "undelivered" ||
    result.messageId === "already-sent-this-wake" ||
    result.messageId === "already-landed"
  ) {
    return { ok: false, output: "the checklist message didn't land — try again" };
  }
  holder.set(seatKey, result.messageId);
  return { ok: true };
}

export function checklistTool(ctx: ToolsetContext): ToolFactory {
  return defineTool(
    "checklist",
    "Post/update a live progress checklist for this piece of work — it edits ONE message in place, in the conversation whose [rN] ref you pass. Most replies don't need one: reach for it only when the work is genuinely long and multi-step, with 2-4 high-level goals (what you're finding out, not which tools you'll run). Call it FIRST with the stages (all done:false), then flip each done as you finish. Input: { items: [{ text, done }], ref }. It renders alongside your reply there — a checklist without any words in that conversation shows nothing.",
    ChecklistArgsSchema,
    async ({ items, ref }, toolCtx) => {
      const resolved = resolveRefTarget(
        toolCtx,
        ref,
        `"${ref}" is not a ref — seat the checklist with the [rN] tag of the conversation its work is for`,
      );
      if ("success" in resolved) return resolved;
      const seat = anchorForTarget(resolved.target);
      const blocked = scopeViolation(toolCtx, seat);
      if (blocked) return blocked;
      const holder = toolCtx.checklist;
      if (!holder) return { success: false, output: "checklist is not available in this turn" };
      const published = await publishChecklist(toolCtx, seat, items, holder);
      if (!published.ok) return { success: false, output: published.output };
      pushEffect(toolCtx, {
        kind: "checklist",
        items: items.length,
        done: items.filter((item) => item.done).length,
      });
      return {
        success: true,
        output: `checklist: ${items.filter((item) => item.done).length}/${items.length} done`,
      };
    },
  )(ctx);
}

export function stepBackTool(ctx: ToolsetContext): ToolFactory {
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
      pushEffect(toolCtx, {
        kind: "stepped_back",
        venueId: key.venueId,
        threadRootId: key.threadRootId,
        why,
      });
      return { success: true, output: "stepped back — a mention brings you back in" };
    },
  )(ctx);
}
