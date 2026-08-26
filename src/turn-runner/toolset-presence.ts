import { asString, isRecord } from "../guard";
import type { Anchor } from "../ledger/tasks";
import { getTask, transition } from "../ledger/tasks";
import { closeAttentionItemsForThread } from "../ledger/attention";
import { stepBack, conversationOf, convoKey } from "../ledger/conversations";
import { checkPostingScope, pushEffect, recordPostedThread, type ToolFactory, type ToolsetContext } from "./toolset-types";

export function replyTool(ctx: ToolsetContext): ToolFactory {
  // One bounce per unread target per attempt; second send goes through.
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
      const toolArgs = { text: asString(raw.text), ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const target = toolArgs.ref ? ctx.refs?.get(toolArgs.ref) : undefined;
      if (!target) {
        return { success: false, output: `"${toolArgs.ref ?? ""}" is not a ref — copy the [rN] tag (like r3) from the start of a line you were shown; timestamps and channel ids are labels, not addresses` };
      }
      const key = conversationOf(target);
      const anchor: Anchor = { venueId: key.venueId, threadRootId: key.threadRootId };
      const violation = checkPostingScope(ctx, anchor);
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };

      // via='search': first send returns the conversation card; re-send posts and engages.
      if (target.via === "search" && ctx.renderConversationCard && !bounced.has(toolArgs.ref!)) {
        bounced.add(toolArgs.ref!);
        const card = ctx.renderConversationCard(key);
        return {
          success: false,
          output: `not sent — you haven't read this conversation this turn:\n${card}\nif your reply still holds against all of that, send it again and it goes through.`,
        };
      }

      // Never post broker denial strings.
      const HARNESS_TOKENS = ["requires_confirmation:", "posting_scope_violation", "not_available_for_turn_kind", "interactive_consequential_denied", "Requesting confirmation to call", "queued — it posts when your turn ends"];
      const leaked = HARNESS_TOKENS.find((tok) => toolArgs.text.includes(tok));
      if (leaked) {
        return { success: false, output: `that reads like my own internal scaffolding ("${leaked}") — say it in your words instead` };
      }

      // §5.5: no direct address on this conversation → buffer reply until turn end.
      if (ctx.bufferReply?.(anchor, toolArgs.text)) {
        return { success: true, output: "queued — it posts when your turn ends, unless the conversation has moved by then (it would come back to you next time instead)" };
      }

      const result = await ctx.postMessage(anchor, toolArgs.text);
      // Sentinel undelivered id: not a real post — must not engage or close attention.
      if (result.messageId === "undelivered") {
        return { success: false, output: "that didn't send — the surface rejected it after retries. try again, or let it go" };
      }
      if (result.messageId === "already-landed") {
        return { success: true, output: "already posted — the room has these exact words from moments ago; nothing sent twice" };
      }
      if (result.messageId === "already-sent-this-wake") {
        return { success: true, output: "posted" }; // an earlier attempt of this wake already sent it
      }
      recordPostedThread(ctx, anchor, result.messageId);
      pushEffect(ctx, { kind: "posted", anchor, text: toolArgs.text });
      return { success: true, output: "posted" };
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
      const toolArgs = { emoji: asString(raw.emoji), ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const emoji = toolArgs.emoji.replaceAll(":", "").trim();
      if (!emoji) return { success: false, output: "empty emoji name" };
      const target = toolArgs.ref ? ctx.refs?.get(toolArgs.ref) : undefined;
      if (!target?.ts) return { success: false, output: "no such message ref — reactions land on a MESSAGE's [rN] tag, not a conversation's" };
      if (!ctx.reactTo) return { success: false, output: "this turn cannot react" };
      const violation = checkPostingScope(ctx, { venueId: target.venueId, threadRootId: null });
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };
      try {
        await ctx.reactTo(target.venueId, target.ts, emoji, target.threadRootId);
      } catch (error) {
        return { success: false, output: `reaction failed: ${error instanceof Error ? error.message : String(error)}` };
      }
      pushEffect(ctx, { kind: "reacted", emoji, venueId: target.venueId, ts: target.ts });
      return { success: true, output: `reacted :${emoji}:` };
    },
  };
}

export function setWakeTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "set_wake",
      description: "Yield this execution, scheduling it to wake and resume at a future time. Input: { wakeAt } (ISO-8601).",
      inputSchema: { type: "object", additionalProperties: false, required: ["wakeAt"], properties: { wakeAt: { type: "string" } } },
    },
    impl: async (args) => {
      const toolArgs = { wakeAt: asString(isRecord(args) ? args.wakeAt : undefined) };
      if (!ctx.taskId) return { success: false, output: "set_wake is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return { success: false, output: "this task is paused waiting on a human go-ahead — stop here and end the turn" };
      }
      // Parse wake_at, clamp horizon, re-serialize canonical ISO.
      const parsed = Date.parse(toolArgs.wakeAt);
      if (Number.isNaN(parsed)) return { success: false, output: "wakeAt must be an ISO-8601 timestamp" };
      const now = Date.parse(ctx.clock());
      if (parsed <= now) return { success: false, output: "wakeAt is in the past — pick a future time" };
      const MAX_WAKE_HORIZON_MS = 90 * 24 * 60 * 60 * 1000;
      const wakeAt = new Date(Math.min(parsed, now + MAX_WAKE_HORIZON_MS)).toISOString();
      transition(ctx.db, ctx.clock, ctx.taskId, "waiting", { type: "yield_timer", wakeAt });
      pushEffect(ctx, { kind: "yielded_timer", taskId: ctx.taskId, wakeAt });
      return { success: true, output: `task ${ctx.taskId} yielded until ${wakeAt}` };
    },
  };
}

function renderChecklist(items: { text: string; done: boolean }[]): string {
  return items.map((item) => `${item.done ? "✅" : "⬜️"} ${item.text}`).join("\n");
}

export function checklistTool(ctx: ToolsetContext): ToolFactory {
  // Checklist seated by ref (model-chosen conversation); ref-bearing turns only.
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
            items: { type: "object", additionalProperties: false, required: ["text", "done"], properties: { text: { type: "string" }, done: { type: "boolean" } } },
          },
          ref: { type: "string", pattern: "^r\\d+$" },
        },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const items = Array.isArray(raw.items) ? raw.items.filter(isRecord).map((item) => ({ text: asString(item.text), done: item.done === true })) : [];
      const toolArgs = { items, ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const target = toolArgs.ref ? ctx.refs?.get(toolArgs.ref) : undefined;
      if (!target) {
        return { success: false, output: `"${toolArgs.ref ?? ""}" is not a ref — seat the checklist with the [rN] tag of the conversation its work is for` };
      }
      const key = conversationOf(target);
      const seat: Anchor = { venueId: key.venueId, threadRootId: key.threadRootId };
      const violation = checkPostingScope(ctx, seat);
      if (violation) return { success: false, output: `posting_scope_violation: ${violation}` };
      const holder = ctx.checklist;
      if (!holder) return { success: false, output: "checklist is not available in this turn" };
      // Prefer native task cards on the seat conversation's stream.
      const native = ctx.renderChecklist ? await ctx.renderChecklist(toolArgs.items, seat) : false;
      if (!native) {
        const text = renderChecklist(toolArgs.items);
        const seatKey = convoKey(seat.venueId, seat.threadRootId);
        const existing = holder.get(seatKey);
        if (existing && ctx.updateMessage) {
          await ctx.updateMessage(seat.venueId, existing, text);
        } else {
          const result = await ctx.postMessage(seat, text); // first call, or no edit support → (re)post
          if (result.messageId === "undelivered" || result.messageId === "already-sent-this-wake" || result.messageId === "already-landed") {
            return { success: false, output: "the checklist message didn't land — try again" };
          }
          holder.set(seatKey, result.messageId);
        }
      }
      pushEffect(ctx, { kind: "checklist", items: toolArgs.items.length, done: toolArgs.items.filter((item) => item.done).length });
      return { success: true, output: `checklist: ${toolArgs.items.filter((item) => item.done).length}/${toolArgs.items.length} done` };
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
      const toolArgs = { why: asString(raw.why), ref: typeof raw.ref === "string" ? raw.ref : undefined };
      const target = toolArgs.ref ? ctx.refs?.get(toolArgs.ref) : undefined;
      if (!target) return { success: false, output: "no such ref — step back using an [rN] tag from the conversation you're leaving" };
      const key = conversationOf(target);
      stepBack(ctx.db, ctx.clock, ctx.identity.id, key.venueId, key.threadRootId, toolArgs.why);
      // Durable leave reason rides future wakes; attention pass may reopen if still owed.
      closeAttentionItemsForThread(ctx.db, ctx.clock, ctx.identity.id, key.venueId, key.threadRootId, "stepped back");
      pushEffect(ctx, { kind: "stepped_back", venueId: key.venueId, threadRootId: key.threadRootId, why: toolArgs.why });
      return { success: true, output: "stepped back — a mention brings you back in" };
    },
  };
}
