import {
  dbReadTool,
  githubApiTool,
  linearGraphqlTool,
  notionApiTool,
  opsReadTool,
  slackApiTool,
  tool as define,
} from "@bevyl-ai/agent-tools";
import { asc, desc, eq, ne } from "drizzle-orm";
import { container } from "tsyringe";
import { z } from "zod";
import { Acts } from "./acts";
import { DB, LedgerService, TaskCreate } from "./ledger-service";
import { tasks } from "./ledger/schema";
import { POLICY } from "./policy";
import { requireEnv, TOOL } from "./tokens";

const ledger = () => container.resolve(LedgerService);

function tool<I, O>(
  name: string,
  description: string,
  input: z.ZodType<I>,
  run: (input: I) => Promise<O>,
): void {
  container.register(TOOL, { useValue: define(name, description, input, run) });
}

tool(
  "task_create",
  "Delegate to a worker; the spec is its whole briefing.",
  TaskCreate,
  async (args) => {
    const task = ledger().createTask(args);
    return { id: task.id, status: task.status };
  },
);

tool(
  "task_steer",
  "Append to a task's spec.",
  z.object({ taskId: z.string(), text: z.string() }),
  async ({ taskId, text }) => {
    const task = ledger().appendGuidance(taskId, text);
    return { id: task.id, status: task.status };
  },
);

tool(
  "task_cancel",
  "Cancel a task.",
  z.object({ taskId: z.string(), report: z.string().optional() }),
  async ({ taskId, report }) => {
    const task = ledger().requireTask(taskId);
    ledger().transition(taskId, {
      type: "finish",
      outcome: "cancelled",
      report: report ?? `Cancelled "${task.title}".`,
    });
    return `task ${taskId} cancelled`;
  },
);

tool(
  "mute_thread",
  "Mute a thread until mentioned there again.",
  z.object({ why: z.string(), channel: z.string(), thread_ts: z.string() }),
  async ({ why, channel, thread_ts }) => {
    ledger().mute(channel, thread_ts, why);
    return "muted; a mention brings you back";
  },
);

tool("task_query", "Your open and recently finished tasks.", z.object({}), async () => {
  const { query } = container.resolve(DB);
  return {
    open: query.tasks
      .findMany({ where: ne(tasks.status, "done"), orderBy: asc(tasks.openedAt) })
      .sync(),
    recentTerminals: query.tasks
      .findMany({ where: eq(tasks.status, "done"), orderBy: desc(tasks.updatedAt), limit: 10 })
      .sync(),
  };
});

tool(
  "reply",
  "Post a message; omit thread_ts for channel level.",
  z.object({ text: z.string(), channel: z.string(), thread_ts: z.string().optional() }),
  ({ text, channel, thread_ts }) => container.resolve(Acts).reply(channel, thread_ts ?? null, text),
);

tool(
  "react",
  "React to a message.",
  z.object({
    emoji: z.string().transform((s) => s.replaceAll(":", "").trim()),
    channel: z.string(),
    ts: z.string(),
  }),
  async ({ emoji, channel, ts }) => {
    await container.resolve(Acts).react(channel, ts, emoji);
    return `reacted :${emoji}:`;
  },
);

for (const kit of [
  linearGraphqlTool(),
  githubApiTool(),
  notionApiTool(),
  opsReadTool(),
  dbReadTool(),
  slackApiTool(
    "slack_api",
    requireEnv("SLACK_BOT_TOKEN"),
    "Any Slack Web API method with its documented arguments; raw response back. Posting and reacting go through reply and react.",
  ),
])
  container.register(TOOL, { useValue: kit });

const FutureTime = z
  .string()
  .refine((s) => Date.parse(s) > Date.now(), "must be an ISO-8601 timestamp in the future")
  .transform((s) =>
    new Date(Math.min(Date.parse(s), Date.now() + 90 * 24 * 60 * 60 * 1000)).toISOString(),
  );

export const taskTools = (taskId: string) => [
  define(
    "task_complete",
    "Finish this task with a report.",
    z.object({ outcome: z.enum(["done", "failed"]), report: z.string() }),
    async ({ outcome, report }) => {
      ledger().transition(taskId, { type: "finish", outcome, report });
      return `task ${taskId} ${outcome}`;
    },
  ),
  define(
    "task_ask",
    "Ask a human a question; pauses the task.",
    z.object({ question: z.string() }),
    async ({ question }) => {
      ledger().transition(taskId, {
        type: "wait",
        waitingOn: "human",
        why: question,
        wakeAt: new Date(Date.now() + container.resolve(POLICY).tasks.park_after_ms).toISOString(),
      });
      return `task ${taskId} waiting on a human`;
    },
  ),
  define(
    "set_wake",
    "Pause this task until an ISO-8601 time.",
    z.object({ wakeAt: FutureTime }),
    async ({ wakeAt }) => {
      container
        .resolve(LedgerService)
        .transition(taskId, { type: "wait", waitingOn: "timer", wakeAt });
      return `paused until ${wakeAt}; the task picks up again then`;
    },
  ),
];
