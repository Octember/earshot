import { tool } from "@bevyl-ai/agent-tools";
import { z } from "zod";
import type { Acts } from "./acts";
import type { LedgerService } from "./ledger-service";

export const replyTool = (acts: Acts) =>
  tool(
    "reply",
    "Post a message; omit thread_ts for channel level.",
    z.object({ text: z.string(), channel: z.string(), thread_ts: z.string().optional() }),
    ({ text, channel, thread_ts }) => acts.reply(channel, thread_ts ?? null, text),
  );

export const reactTool = (acts: Acts) =>
  tool(
    "react",
    "React to a message.",
    z.object({ emoji: z.string(), channel: z.string(), ts: z.string() }),
    async ({ emoji: raw, channel, ts }) => {
      const emoji = raw.replaceAll(":", "").trim();
      await acts.react(channel, ts, emoji);
      return `reacted :${emoji}:`;
    },
  );

export const setWakeTool = (ledger: LedgerService, taskId: string) =>
  tool(
    "set_wake",
    "Pause this task until an ISO-8601 time.",
    z.object({ wakeAt: z.string() }),
    async ({ wakeAt: raw }) => {
      const parsed = Date.parse(raw);
      const at = Date.now();
      if (!(parsed > at)) throw new Error("wakeAt must be an ISO-8601 timestamp in the future");
      const wakeAt = new Date(Math.min(parsed, at + 90 * 24 * 60 * 60 * 1000)).toISOString();
      ledger.transition(taskId, { type: "wait", waitingOn: "timer", wakeAt });
      return `paused until ${wakeAt}; the task picks up again then`;
    },
  );

export const muteThreadTool = (ledger: LedgerService, acts: Acts) =>
  tool(
    "mute_thread",
    "Mute a thread until mentioned there again.",
    z.object({ why: z.string(), channel: z.string(), thread_ts: z.string() }),
    async ({ why, channel, thread_ts }) => {
      ledger.mute(channel, thread_ts, why);
      acts.note(`mute:${channel}:${thread_ts}`);
      return "muted; a mention brings you back";
    },
  );
