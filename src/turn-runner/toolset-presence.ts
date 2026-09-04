import { z } from "zod";
import { stepBack } from "../ledger/stance";
import type { ToolsetContext } from "./toolset-types";
import { activeTaskFor, type ToolResult } from "./toolset-tasks-util";
import { transition } from "../ledger/tasks-transition";
import { postReply, reactInWake } from "../service-wake-post";
import type { DynamicTool } from "@bevyl-ai/agent-tools";

const Reply = z.object({ text: z.string(), channel: z.string(), thread_ts: z.string().optional() });
const React = z.object({ emoji: z.string(), channel: z.string(), ts: z.string() });
const SetWake = z.object({ wakeAt: z.string() });
const StepBack = z.object({ why: z.string(), channel: z.string(), thread_ts: z.string() });

function scopeViolation(ctx: ToolsetContext, channel: string): ToolResult | null {
  const venues = ctx.identity.venueIds;
  return venues.includes("*") || venues.includes(channel)
    ? null
    : { success: false, output: `not sent: you may only post to venues you serve, got ${channel}` };
}

export function replyTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "reply",
      description:
        "Post a message. Input: { text, channel, thread_ts? } — channel and thread_ts are the [channel ts] coordinates on the lines you were shown; thread_ts is the thread's root ts (reply in that thread), omit it to post at the channel level. If the conversation moved while you were writing, the reply comes back to you with what is new; send it again if it still holds.",
      inputSchema: z.toJSONSchema(Reply),
    },
    run: async (raw) => {
      const { text, channel, thread_ts } = Reply.parse(raw);
      const blocked = scopeViolation(ctx, channel);
      if (blocked) return blocked;
      if (!ctx.post) return { success: false, output: "this turn cannot post" };
      const result = await postReply(
        ctx.post,
        { venueId: channel, threadRootId: thread_ts ?? null },
        text,
      );
      if (!("held" in result) || result.held === "duplicate")
        return { success: true, output: "posted" };
      if (result.held === "moved")
        return {
          success: false,
          output:
            "not sent — the conversation moved while you were writing; read what is new and send it again if it still holds.",
        };
      return {
        success: false,
        output: "that didn't send — the surface rejected it after retries. try again, or let it go",
      };
    },
  };
}

export function reactTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "react",
      description:
        "Add an emoji reaction to a message. Input: { emoji, channel, ts } — emoji name without colons; channel and ts are the message's [channel ts] coordinates.",
      inputSchema: z.toJSONSchema(React),
    },
    run: async (raw) => {
      const { emoji: rawEmoji, channel, ts } = React.parse(raw);
      const emoji = rawEmoji.replaceAll(":", "").trim();
      if (!emoji) return { success: false, output: "empty emoji name" };
      const blocked = scopeViolation(ctx, channel);
      if (blocked) return blocked;
      if (!ctx.post) return { success: false, output: "this turn cannot react" };
      await reactInWake(ctx.post, channel, ts, emoji);
      ctx.effects.push({ kind: "reacted", emoji, venueId: channel, ts });
      return { success: true, output: `reacted :${emoji}:` };
    },
  };
}

export function setWakeTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "set_wake",
      description:
        "Yield this execution, scheduling it to wake and resume at a future time. Input: { wakeAt } (ISO-8601).",
      inputSchema: z.toJSONSchema(SetWake),
    },
    run: async (raw) => {
      const { wakeAt: wakeAtRaw } = SetWake.parse(raw);
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
  };
}

export function stepBackTool(ctx: ToolsetContext): DynamicTool {
  return {
    spec: {
      name: "step_back",
      description:
        "Leave a thread: replies there stop being yours to answer (and stop reaching you) until someone mentions you there again, or you post there again; anything you still owed there is dropped with it. Input: { why, channel, thread_ts }. Use when the humans have it between them, or when someone asks you to stop.",
      inputSchema: z.toJSONSchema(StepBack),
    },
    run: async (raw) => {
      const { why, channel, thread_ts } = StepBack.parse(raw);
      stepBack(ctx.db, ctx.clock, ctx.identity.id, channel, thread_ts, why);
      ctx.effects.push({ kind: "stepped_back", venueId: channel, threadRootId: thread_ts, why });
      return { success: true, output: "stepped back — a mention brings you back in" };
    },
  };
}
