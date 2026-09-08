import {
  dbReadTool,
  githubApiTool,
  linearGraphqlTool,
  notionApiTool,
  opsReadTool,
  slackApiTool,
  tool,
  type Tools,
} from "@bevyl-ai/agent-tools";
import { asc, desc, eq, ne } from "drizzle-orm";
import { container } from "tsyringe";
import { z } from "zod";
import { DB, LedgerService, TaskCreate } from "./ledger-service";
import { tasks } from "./ledger/schema";
import { POLICY } from "./policy";
import { requireEnv } from "./tokens";
import { Voice } from "./voice";

const ledger = () => container.resolve(LedgerService);

const shared: Tools = (server) => {
  tool(
    server,
    "task_create",
    "Delegate to a worker; the spec is its whole briefing.",
    TaskCreate.shape,
    async (args) => {
      const task = ledger().createTask(args);
      return { id: task.id, status: task.status };
    },
  );
  tool(
    server,
    "task_steer",
    "Append to a task's spec.",
    { taskId: z.string(), text: z.string() },
    async ({ taskId, text: more }) => {
      const task = ledger().appendGuidance(taskId, more);
      return { id: task.id, status: task.status };
    },
  );
  tool(
    server,
    "task_cancel",
    "Cancel a task.",
    { taskId: z.string(), report: z.string().optional() },
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
  tool(server, "task_query", "Your open and recently finished tasks.", {}, async () => {
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
    server,
    "mute_thread",
    "Mute a thread until mentioned there again.",
    { why: z.string(), channel: z.string(), thread_ts: z.string() },
    async ({ why, channel, thread_ts }) => {
      ledger().mute(channel, thread_ts, why);
      return "muted; a mention brings you back";
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
    kit(server);
};

export const residentTools: Tools = (server) => {
  shared(server);
  tool(
    server,
    "reply",
    "Post a message; omit thread_ts for channel level.",
    { text: z.string(), channel: z.string(), thread_ts: z.string().optional() },
    ({ text: body, channel, thread_ts }) =>
      container.resolve(Voice).reply(channel, thread_ts ?? null, body),
  );
  tool(
    server,
    "react",
    "React to a message.",
    {
      emoji: z.string().transform((s) => s.replaceAll(":", "").trim()),
      channel: z.string(),
      ts: z.string(),
    },
    async ({ emoji, channel, ts }) => {
      await container.resolve(Voice).react(channel, ts, emoji);
      return `reacted :${emoji}:`;
    },
  );
};

const FutureTime = z
  .string()
  .refine((s) => Date.parse(s) > Date.now(), "must be an ISO-8601 timestamp in the future")
  .transform((s) =>
    new Date(Math.min(Date.parse(s), Date.now() + 90 * 24 * 60 * 60 * 1000)).toISOString(),
  );

export const workerTools =
  (taskId: string): Tools =>
  (server) => {
    shared(server);
    tool(
      server,
      "task_complete",
      "Finish this task with a report.",
      { outcome: z.enum(["done", "failed"]), report: z.string() },
      async ({ outcome, report }) => {
        ledger().transition(taskId, { type: "finish", outcome, report });
        return `task ${taskId} ${outcome}`;
      },
    );
    tool(
      server,
      "task_ask",
      "Ask a human a question; pauses the task.",
      { question: z.string() },
      async ({ question }) => {
        ledger().transition(taskId, {
          type: "wait",
          waitingOn: "human",
          why: question,
          wakeAt: new Date(
            Date.now() + container.resolve(POLICY).tasks.park_after_ms,
          ).toISOString(),
        });
        return `task ${taskId} waiting on a human`;
      },
    );
    tool(
      server,
      "set_wake",
      "Pause this task until an ISO-8601 time.",
      { wakeAt: FutureTime },
      async ({ wakeAt }) => {
        ledger().transition(taskId, { type: "wait", waitingOn: "timer", wakeAt });
        return `paused until ${wakeAt}; the task picks up again then`;
      },
    );
  };

export const earTools: Tools = (server) => {
  tool(
    server,
    "verdict",
    "One verdict per conversation, with a brief why.",
    {
      decision: z.enum(["hold", "wake"]),
      why: z.string(),
      channel: z.string(),
      thread_ts: z.string(),
    },
    async ({ decision, channel, thread_ts }) => {
      if (decision === "wake") ledger().wake(channel, thread_ts);
      return "noted";
    },
  );
};
