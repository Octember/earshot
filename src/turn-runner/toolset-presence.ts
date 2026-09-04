import { z } from "zod";
import { stepBack } from "../ledger/stance";
import { transition } from "../ledger/tasks-transition";
import { postReply, reactInWake, type WakePostContext } from "../service-wake-post";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { IdentityConfig } from "../policy";
import type { Service } from "../service";

const Reply = z.object({ text: z.string(), channel: z.string(), thread_ts: z.string().optional() });
const React = z.object({ emoji: z.string(), channel: z.string(), ts: z.string() });
const SetWake = z.object({ wakeAt: z.string() });
const StepBack = z.object({ why: z.string(), channel: z.string(), thread_ts: z.string() });

function serves(identity: IdentityConfig, channel: string): boolean {
  return identity.venue_ids.includes("*") || identity.venue_ids.includes(channel);
}

export function replyTool(identity: IdentityConfig, post: WakePostContext | null): DynamicTool {
  return {
    spec: {
      name: "reply",
      description:
        "Post a message. Input: { text, channel, thread_ts? } — channel and thread_ts are the [channel ts] coordinates on the lines you were shown; thread_ts is the thread's root ts (reply in that thread), omit it to post at the channel level. If the conversation moved while you were writing, the reply comes back to you with what is new; send it again if it still holds.",
      inputSchema: z.toJSONSchema(Reply),
    },
    run: async (raw) => {
      const { text, channel, thread_ts } = Reply.parse(raw);
      if (!serves(identity, channel))
        return { success: false, output: `you may only post to venues you serve, got ${channel}` };
      if (!post) return { success: false, output: "this turn cannot post" };
      return postReply(post, channel, thread_ts ?? null, text);
    },
  };
}

export function reactTool(identity: IdentityConfig, post: WakePostContext | null): DynamicTool {
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
      if (!serves(identity, channel))
        return { success: false, output: `you may only react in venues you serve, got ${channel}` };
      if (!post) return { success: false, output: "this turn cannot react" };
      await reactInWake(post, channel, ts, emoji);
      return { success: true, output: `reacted :${emoji}:` };
    },
  };
}

export function setWakeTool(host: Service, taskId: string): DynamicTool {
  return {
    spec: {
      name: "set_wake",
      description:
        "Yield this execution, scheduling it to wake and resume at a future time. Input: { wakeAt } (ISO-8601).",
      inputSchema: z.toJSONSchema(SetWake),
    },
    run: async (raw) => {
      const parsed = Date.parse(SetWake.parse(raw).wakeAt);
      const at = Date.now();
      if (!(parsed > at))
        return { success: false, output: "wakeAt must be an ISO-8601 timestamp in the future" };
      const wakeAt = new Date(Math.min(parsed, at + 90 * 24 * 60 * 60 * 1000)).toISOString();
      transition(host.db, taskId, { type: "wait", waitingOn: "timer", wakeAt });
      return { success: true, output: `paused until ${wakeAt}; the task picks up again then` };
    },
  };
}

export function stepBackTool(
  host: Service,
  identity: IdentityConfig,
  post: WakePostContext | null,
): DynamicTool {
  return {
    spec: {
      name: "step_back",
      description:
        "Leave a thread: replies there stop being yours to answer (and stop reaching you) until someone mentions you there again, or you post there again; anything you still owed there is dropped with it. Input: { why, channel, thread_ts }. Use when the humans have it between them, or when someone asks you to stop.",
      inputSchema: z.toJSONSchema(StepBack),
    },
    run: async (raw) => {
      const { why, channel, thread_ts } = StepBack.parse(raw);
      stepBack(host.db, identity.id, channel, thread_ts, why);
      post?.acts.add(`step_back:${channel}:${thread_ts}`);
      return { success: true, output: "stepped back — a mention brings you back in" };
    },
  };
}
