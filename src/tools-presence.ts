import { z } from "zod";
import { stepBack } from "./ledger/stance";
import { transition } from "./ledger/tasks-transition";
import type { Acts } from "./acts";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { Ledger } from "./ledger/db";

const Reply = z.object({ text: z.string(), channel: z.string(), thread_ts: z.string().optional() });
const React = z.object({ emoji: z.string(), channel: z.string(), ts: z.string() });
const SetWake = z.object({ wakeAt: z.string() });
const StepBack = z.object({ why: z.string(), channel: z.string(), thread_ts: z.string() });

export function replyTool(acts: Acts): DynamicTool<z.infer<typeof Reply>, string> {
  return {
    name: "reply",
    description:
      "Post a message. thread_ts is the thread root from the line's [channel ts]; omit it to post at channel level.",
    input: Reply,
    async run({ text, channel, thread_ts }) {
      return acts.reply(channel, thread_ts ?? null, text);
    },
  };
}

export function reactTool(acts: Acts): DynamicTool<z.infer<typeof React>, string> {
  return {
    name: "react",
    description: "React to a message by its [channel ts].",
    input: React,
    async run({ emoji: rawEmoji, channel, ts }) {
      const emoji = rawEmoji.replaceAll(":", "").trim();
      await acts.react(channel, ts, emoji);
      return `reacted :${emoji}:`;
    },
  };
}

export function setWakeTool(
  db: Ledger,
  taskId: string,
): DynamicTool<z.infer<typeof SetWake>, string> {
  return {
    name: "set_wake",
    description: "Pause this task until an ISO-8601 time, then resume.",
    input: SetWake,
    async run({ wakeAt: raw }) {
      const parsed = Date.parse(raw);
      const at = Date.now();
      if (!(parsed > at)) throw new Error("wakeAt must be an ISO-8601 timestamp in the future");
      const wakeAt = new Date(Math.min(parsed, at + 90 * 24 * 60 * 60 * 1000)).toISOString();
      transition(db, taskId, { type: "wait", waitingOn: "timer", wakeAt });
      return `paused until ${wakeAt}; the task picks up again then`;
    },
  };
}

export function stepBackTool(
  db: Ledger,
  acts: Acts,
): DynamicTool<z.infer<typeof StepBack>, string> {
  return {
    name: "step_back",
    description:
      "Leave a thread: its replies stop reaching you until someone mentions you there or you post there again.",
    input: StepBack,
    async run({ why, channel, thread_ts }) {
      stepBack(db, channel, thread_ts, why);
      acts.note(`step_back:${channel}:${thread_ts}`);
      return "stepped back — a mention brings you back in";
    },
  };
}
