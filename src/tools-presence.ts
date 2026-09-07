import { z } from "zod";
import type { Acts } from "./acts";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { LedgerService } from "./ledger-service";

const Reply = z.object({ text: z.string(), channel: z.string(), thread_ts: z.string().optional() });
const React = z.object({ emoji: z.string(), channel: z.string(), ts: z.string() });
const SetWake = z.object({ wakeAt: z.string() });
const StepBack = z.object({ why: z.string(), channel: z.string(), thread_ts: z.string() });

export function replyTool(acts: Acts): DynamicTool<z.infer<typeof Reply>, string> {
  return {
    name: "reply",
    description: "Post a message; omit thread_ts for channel level.",
    input: Reply,
    async run({ text, channel, thread_ts }) {
      return acts.reply(channel, thread_ts ?? null, text);
    },
  };
}

export function reactTool(acts: Acts): DynamicTool<z.infer<typeof React>, string> {
  return {
    name: "react",
    description: "React to a message.",
    input: React,
    async run({ emoji: rawEmoji, channel, ts }) {
      const emoji = rawEmoji.replaceAll(":", "").trim();
      await acts.react(channel, ts, emoji);
      return `reacted :${emoji}:`;
    },
  };
}

export function setWakeTool(
  ledger: LedgerService,
  taskId: string,
): DynamicTool<z.infer<typeof SetWake>, string> {
  return {
    name: "set_wake",
    description: "Pause this task until an ISO-8601 time.",
    input: SetWake,
    async run({ wakeAt: raw }) {
      const parsed = Date.parse(raw);
      const at = Date.now();
      if (!(parsed > at)) throw new Error("wakeAt must be an ISO-8601 timestamp in the future");
      const wakeAt = new Date(Math.min(parsed, at + 90 * 24 * 60 * 60 * 1000)).toISOString();
      ledger.transition(taskId, { type: "wait", waitingOn: "timer", wakeAt });
      return `paused until ${wakeAt}; the task picks up again then`;
    },
  };
}

export function stepBackTool(
  ledger: LedgerService,
  acts: Acts,
): DynamicTool<z.infer<typeof StepBack>, string> {
  return {
    name: "step_back",
    description: "Leave a thread until mentioned there again.",
    input: StepBack,
    async run({ why, channel, thread_ts }) {
      ledger.stepBack(channel, thread_ts, why);
      acts.note(`step_back:${channel}:${thread_ts}`);
      return "stepped back — a mention brings you back in";
    },
  };
}
