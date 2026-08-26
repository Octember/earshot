import { asString, isRecord } from "../guard";
import { getTask, transition } from "../ledger/tasks";
import { closeAttentionItemsForThread } from "../ledger/attention";
import { stepBack } from "../ledger/conversations";
import { pushEffect, type ToolFactory, type ToolsetContext } from "./toolset-types";
import {
  anchorForTarget,
  deliverReply,
  leakedHarnessToken,
  parseChecklistItems,
  parseRefArg,
  renderChecklistText,
  resolveRefTarget,
  scopeViolation,
} from "./toolset-presence-util";
import { convoKey } from "../ledger/conversations";
import { conversationOf } from "../ledger/conversations";
import type { Anchor } from "../ledger/tasks";

export function replyTool(ctx: ToolsetContext): ToolFactory {
  const bounced = new Set<string>();
  return {
    spec: {
      name: "reply",
      description:
        "Post a message into a conversation. ref is the [rN] tag copied from the start of the line you're answering — always the r-number (like r3), never a timestamp, channel id, or thread id (those are labels, not addresses). A message ref replies in its thread; a conversation ref posts there. Refs come only from what you can see — there is no other way to address a room.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["text", "ref"],
        properties: { text: { type: "string" }, ref: { type: "string", pattern: "^r\\d+$" } },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const text = asString(raw.text);
      const ref = parseRefArg(raw);
      const resolved = resolveRefTarget(
        ctx,
        ref,
        `"$ref" is not a ref — copy the [rN] tag (like r3) from the start of a line you were shown; timestamps and channel ids are labels, not addresses`,
      );
      if ("success" in resolved) return resolved;
      const anchor = anchorForTarget(resolved.target);
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
      const leaked = leakedHarnessToken(text);
      if (leaked) {
        return {
          success: false,
          output: `that reads like my own internal scaffolding ("${leaked}") — say it in your words instead`,
        };
      }
      if (ctx.bufferReply?.(anchor, text)) {
        return {
          success: true,
          output:
            "queued — it posts when your turn ends, unless the conversation has moved by then (it would come back to you next time instead)",
        };
      }
      return deliverReply(ctx, anchor, text);
    },
  };
}

export function reactTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "react",
      description:
        'Add an emoji reaction to a message. Input: { emoji, ref } — emoji name without colons (e.g. "thumbsup", "white_check_mark", "eyes"); ref is the message\'s [rN] tag. Use when a reaction alone is the best response.',
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["emoji", "ref"],
        properties: { emoji: { type: "string" }, ref: { type: "string", pattern: "^r\\d+$" } },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const emoji = asString(raw.emoji).replaceAll(":", "").trim();
      if (!emoji) return { success: false, output: "empty emoji name" };
      const ref = parseRefArg(raw);
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
      const blocked = scopeViolation(ctx, { venueId: resolved.target.venueId, threadRootId: null });
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
      pushEffect(ctx, {
        kind: "reacted",
        emoji,
        venueId: resolved.target.venueId,
        ts: resolved.target.ts,
      });
      return { success: true, output: `reacted :${emoji}:` };
    },
  };
}

export function setWakeTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "set_wake",
      description:
        "Yield this execution, scheduling it to wake and resume at a future time. Input: { wakeAt } (ISO-8601).",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["wakeAt"],
        properties: { wakeAt: { type: "string" } },
      },
    },
    impl: async (args) => {
      const wakeAtRaw = asString(isRecord(args) ? args.wakeAt : undefined);
      if (!ctx.taskId) {
        return { success: false, output: "set_wake is only available to an execution's own turns" };
      }
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return {
          success: false,
          output: "this task is paused waiting on a human go-ahead — stop here and end the turn",
        };
      }
      const parsed = Date.parse(wakeAtRaw);
      if (Number.isNaN(parsed))
        return { success: false, output: "wakeAt must be an ISO-8601 timestamp" };
      const now = Date.parse(ctx.clock());
      if (parsed <= now)
        return { success: false, output: "wakeAt is in the past — pick a future time" };
      const wakeAt = new Date(Math.min(parsed, now + 90 * 24 * 60 * 60 * 1000)).toISOString();
      transition(ctx.db, ctx.clock, ctx.taskId, "waiting", { type: "yield_timer", wakeAt });
      pushEffect(ctx, { kind: "yielded_timer", taskId: ctx.taskId, wakeAt });
      return { success: true, output: `task ${ctx.taskId} yielded until ${wakeAt}` };
    },
  };
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
  return {
    spec: {
      name: "checklist",
      description:
        "Post/update a live progress checklist for this piece of work — it edits ONE message in place, in the conversation whose [rN] ref you pass. Most replies don't need one: reach for it only when the work is genuinely long and multi-step, with 2-4 high-level goals (what you're finding out, not which tools you'll run). Call it FIRST with the stages (all done:false), then flip each done as you finish. Input: { items: [{ text, done }], ref }. It renders alongside your reply there — a checklist without any words in that conversation shows nothing.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["items", "ref"],
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["text", "done"],
              properties: { text: { type: "string" }, done: { type: "boolean" } },
            },
          },
          ref: { type: "string", pattern: "^r\\d+$" },
        },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const items = parseChecklistItems(raw.items);
      const ref = parseRefArg(raw);
      const resolved = resolveRefTarget(
        ctx,
        ref,
        `"$ref" is not a ref — seat the checklist with the [rN] tag of the conversation its work is for`,
      );
      if ("success" in resolved) return resolved;
      const seat = anchorForTarget(resolved.target);
      const blocked = scopeViolation(ctx, seat);
      if (blocked) return blocked;
      const holder = ctx.checklist;
      if (!holder) return { success: false, output: "checklist is not available in this turn" };
      const published = await publishChecklist(ctx, seat, items, holder);
      if (!published.ok) return { success: false, output: published.output };
      pushEffect(ctx, {
        kind: "checklist",
        items: items.length,
        done: items.filter((item) => item.done).length,
      });
      return {
        success: true,
        output: `checklist: ${items.filter((item) => item.done).length}/${items.length} done`,
      };
    },
  };
}

export function stepBackTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "step_back",
      description:
        "Leave a conversation: replies there stop being yours to answer (and stop reaching you) until someone mentions you there again, or you post there again; anything you still owed there is dropped with it. Input: { why, ref } — the conversation's (or any of its messages') [rN] tag. Use when the humans have it between them, or when someone asks you to stop.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["why", "ref"],
        properties: { why: { type: "string" }, ref: { type: "string", pattern: "^r\\d+$" } },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const why = asString(raw.why);
      const ref = parseRefArg(raw);
      const resolved = resolveRefTarget(
        ctx,
        ref,
        "no such ref — step back using an [rN] tag from the conversation you're leaving",
      );
      if ("success" in resolved) return resolved;
      const key = conversationOf(resolved.target);
      stepBack(ctx.db, ctx.clock, ctx.identity.id, key.venueId, key.threadRootId, why);
      closeAttentionItemsForThread(
        ctx.db,
        ctx.clock,
        ctx.identity.id,
        key.venueId,
        key.threadRootId,
        "stepped back",
      );
      pushEffect(ctx, {
        kind: "stepped_back",
        venueId: key.venueId,
        threadRootId: key.threadRootId,
        why,
      });
      return { success: true, output: "stepped back — a mention brings you back in" };
    },
  };
}
