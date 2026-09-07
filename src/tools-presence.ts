import { tool } from "@bevyl-ai/agent-tools";
import { z } from "zod";
import type { Acts } from "./acts";
import type { LedgerService } from "./ledger-service";

const FutureTime = z
  .string()
  .refine((s) => Date.parse(s) > Date.now(), "must be an ISO-8601 timestamp in the future")
  .transform((s) =>
    new Date(Math.min(Date.parse(s), Date.now() + 90 * 24 * 60 * 60 * 1000)).toISOString(),
  );

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
    z.object({
      emoji: z.string().transform((s) => s.replaceAll(":", "").trim()),
      channel: z.string(),
      ts: z.string(),
    }),
    async ({ emoji, channel, ts }) => {
      await acts.react(channel, ts, emoji);
      return `reacted :${emoji}:`;
    },
  );

export const setWakeTool = (ledger: LedgerService, taskId: string) =>
  tool(
    "set_wake",
    "Pause this task until an ISO-8601 time.",
    z.object({ wakeAt: FutureTime }),
    async ({ wakeAt }) => {
      ledger.transition(taskId, { type: "wait", waitingOn: "timer", wakeAt });
      return `paused until ${wakeAt}; the task picks up again then`;
    },
  );

export const muteThreadTool = (ledger: LedgerService) =>
  tool(
    "mute_thread",
    "Mute a thread until mentioned there again.",
    z.object({ why: z.string(), channel: z.string(), thread_ts: z.string() }),
    async ({ why, channel, thread_ts }) => {
      ledger.mute(channel, thread_ts, why);
      return "muted; a mention brings you back";
    },
  );
