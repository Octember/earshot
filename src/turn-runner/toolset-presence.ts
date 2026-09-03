import type { Anchor } from "../ledger/tasks-types";
import { stepBack } from "../ledger/conversations-stance";
import type { ToolsetContext } from "./toolset-types";
import { conversationOf, type RefTarget } from "../ledger/conversations-refs";
import { defineTool, type ToolResult } from "../schemas/tool";
import { activeTaskFor } from "./toolset-tasks-util";
import { transition } from "../ledger/tasks-transition";
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
    "Post a message into a conversation. ref is the [rN] tag on a New line or conversation header — not a timestamp or channel id. A message ref replies in its thread; a header ref posts at the conversation. If the conversation moved while you were writing, the reply comes back to you with what is new; send it again if it still holds.",
    ReplyArgsSchema.extend(LooseRef),
    async ({ text, ref }) => {
      const resolved = resolveRefTarget(
        ctx,
        ref,
        `"${ref}" is not a ref — copy the [rN] tag (like r3) from the start of a line you were shown; timestamps and channel ids are labels, not addresses`,
      );
      if ("success" in resolved) return resolved;
      const anchor = conversationOf(resolved.target);
      const blocked = scopeViolation(ctx, anchor);
      if (blocked) return blocked;
      if (
        resolved.target.via === "search" &&
        ctx.renderConversationCard &&
        ref &&
        !bounced.has(ref)
      ) {
        bounced.add(ref);
        const card = ctx.renderConversationCard(conversationOf(resolved.target));
        return {
          success: false,
          output: `not sent — you haven't read this conversation this turn:\n${card}\nif your reply still holds against all of that, send it again and it goes through.`,
        };
      }
      return deliverReply(ctx, anchor, text);
    },
  );
}

export function reactTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "react",
    "Add an emoji reaction to a message. Input: { emoji, ref } — emoji name without colons; ref is the [rN] tag on a New line (not the conversation header).",
    ReactArgsSchema.extend(LooseRef),
    async ({ emoji: rawEmoji, ref }) => {
      const emoji = rawEmoji.replaceAll(":", "").trim();
      if (!emoji) return { success: false, output: "empty emoji name" };
      const resolved = resolveRefTarget(
        ctx,
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
      if (!ctx.reactTo) return { success: false, output: "this turn cannot react" };
      const blocked = scopeViolation(ctx, {
        venueId: resolved.target.venueId,
        threadRootId: null,
      });
      if (blocked) return blocked;
      try {
        await ctx.reactTo(
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
      ctx.effects.push({
        kind: "reacted",
        emoji,
        venueId: resolved.target.venueId,
        ts: resolved.target.ts,
      });
      return { success: true, output: `reacted :${emoji}:` };
    },
  );
}

export function setWakeTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "set_wake",
    "Yield this execution, scheduling it to wake and resume at a future time. Input: { wakeAt } (ISO-8601).",
    SetWakeArgsSchema,
    async ({ wakeAt: wakeAtRaw }) => {
      const task = activeTaskFor(ctx, "set_wake");
      if ("success" in task) return task;
      const parsed = Date.parse(wakeAtRaw);
      if (Number.isNaN(parsed))
        return { success: false, output: "wakeAt must be an ISO-8601 timestamp" };
      const now = Date.parse(ctx.clock());
      if (parsed <= now)
        return { success: false, output: "wakeAt is in the past — pick a future time" };
      const wakeAt = new Date(Math.min(parsed, now + 90 * 24 * 60 * 60 * 1000)).toISOString();
      transition(ctx.db, ctx.clock, task.id, { type: "wait", waitingOn: "timer", wakeAt });
      ctx.effects.push({ kind: "yielded_timer", taskId: task.id, wakeAt });
      return { success: true, output: `paused until ${wakeAt}; the task picks up again then` };
    },
  );
}

export function stepBackTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "step_back",
    "Leave a conversation: replies there stop being yours to answer (and stop reaching you) until someone mentions you there again, or you post there again; anything you still owed there is dropped with it. Input: { why, ref } — the conversation's (or any of its messages') [rN] tag. Use when the humans have it between them, or when someone asks you to stop.",
    StepBackArgsSchema,
    async ({ why, ref }) => {
      const resolved = resolveRefTarget(
        ctx,
        ref,
        "no such ref — step back using an [rN] tag from the conversation you're leaving",
      );
      if ("success" in resolved) return resolved;
      const key = conversationOf(resolved.target);
      stepBack(ctx.db, ctx.clock, ctx.identity.id, key.venueId, key.threadRootId, why);
      ctx.effects.push({
        kind: "stepped_back",
        venueId: key.venueId,
        threadRootId: key.threadRootId,
        why,
      });
      return { success: true, output: "stepped back — a mention brings you back in" };
    },
  );
}

function resolveRefTarget(
  ctx: ToolsetContext,
  ref: string | undefined,
  missing: string,
): ToolResult | { target: RefTarget } {
  const target = ref ? ctx.refs.get(ref) : undefined;
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
  return violation ? { success: false, output: `not sent: ${violation}` } : null;
}

async function deliverReply(
  ctx: ToolsetContext,
  anchor: Anchor,
  text: string,
): Promise<ToolResult> {
  const result = await ctx.postMessage(anchor, text);
  if (!("held" in result) || result.held === "duplicate")
    return { success: true, output: "posted" };
  if (result.held === "moved")
    return {
      success: false,
      output: `not sent — the conversation moved while you were writing:\n${ctx.renderConversationCard?.(anchor) ?? ""}\nif your reply still holds against all of that, send it again and it goes through.`,
    };
  return {
    success: false,
    output: "that didn't send — the surface rejected it after retries. try again, or let it go",
  };
}
