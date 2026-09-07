import {
  dbReadTool,
  githubApiTool,
  linearGraphqlTool,
  notionApiTool,
  opsReadTool,
  slackApiTool,
  tool,
  type DynamicTool,
} from "@bevyl-ai/agent-tools";
import { asc, desc, eq, ne } from "drizzle-orm";
import {
  container,
  inject,
  instanceCachingFactory,
  singleton,
  type DependencyContainer,
  type InjectionToken,
} from "tsyringe";
import { z } from "zod";
import { DB, LedgerService, TaskCreate } from "./ledger-service";
import { tasks } from "./ledger/schema";
import { POLICY, type Policy } from "./policy";
import { requireEnv, RESIDENT_TOOL, WORKER_TOOL } from "./tokens";

function provide(
  token: InjectionToken<DynamicTool>,
  make: (c: DependencyContainer) => DynamicTool,
) {
  container.register(token, { useFactory: instanceCachingFactory(make) });
}

provide(RESIDENT_TOOL, (c) =>
  tool(
    "task_create",
    "Delegate to a worker; the spec is its whole briefing.",
    TaskCreate,
    async (args) => {
      const task = c.resolve(LedgerService).createTask(args);
      return { id: task.id, status: task.status };
    },
  ),
);

provide(RESIDENT_TOOL, (c) =>
  tool(
    "task_steer",
    "Append to a task's spec.",
    z.object({ taskId: z.string(), text: z.string() }),
    async ({ taskId, text }) => {
      const task = c.resolve(LedgerService).appendGuidance(taskId, text);
      return { id: task.id, status: task.status };
    },
  ),
);

provide(RESIDENT_TOOL, (c) =>
  tool(
    "task_cancel",
    "Cancel a task.",
    z.object({ taskId: z.string(), report: z.string().optional() }),
    async ({ taskId, report }) => {
      const ledger = c.resolve(LedgerService);
      const task = ledger.requireTask(taskId);
      ledger.transition(taskId, {
        type: "finish",
        outcome: "cancelled",
        report: report ?? `Cancelled "${task.title}".`,
      });
      return `task ${taskId} cancelled`;
    },
  ),
);

provide(RESIDENT_TOOL, (c) =>
  tool(
    "mute_thread",
    "Mute a thread until mentioned there again.",
    z.object({ why: z.string(), channel: z.string(), thread_ts: z.string() }),
    async ({ why, channel, thread_ts }) => {
      c.resolve(LedgerService).mute(channel, thread_ts, why);
      return "muted; a mention brings you back";
    },
  ),
);

for (const token of [RESIDENT_TOOL, WORKER_TOOL])
  provide(token, (c) =>
    tool("task_query", "Your open and recently finished tasks.", z.object({}), async () => ({
      open: c
        .resolve(DB)
        .query.tasks.findMany({ where: ne(tasks.status, "done"), orderBy: asc(tasks.openedAt) })
        .sync(),
      recentTerminals: c
        .resolve(DB)
        .query.tasks.findMany({
          where: eq(tasks.status, "done"),
          orderBy: desc(tasks.updatedAt),
          limit: 10,
        })
        .sync(),
    })),
  );

for (const kit of [
  () => linearGraphqlTool(),
  () => githubApiTool(),
  () => notionApiTool(),
  () => opsReadTool(),
  () => dbReadTool(),
  () =>
    slackApiTool(
      "slack_api",
      requireEnv("SLACK_BOT_TOKEN"),
      "Any Slack Web API method with its documented arguments; raw response back. Posting and reacting go through reply and react.",
    ),
])
  for (const token of [RESIDENT_TOOL, WORKER_TOOL]) provide(token, kit);

const FutureTime = z
  .string()
  .refine((s) => Date.parse(s) > Date.now(), "must be an ISO-8601 timestamp in the future")
  .transform((s) =>
    new Date(Math.min(Date.parse(s), Date.now() + 90 * 24 * 60 * 60 * 1000)).toISOString(),
  );

@singleton()
export class TaskTools {
  constructor(
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
  ) {}

  for(taskId: string): DynamicTool[] {
    return [
      tool(
        "task_complete",
        "Finish this task with a report.",
        z.object({ outcome: z.enum(["done", "failed"]), report: z.string() }),
        async ({ outcome, report }) => {
          this.ledger.transition(taskId, { type: "finish", outcome, report });
          return `task ${taskId} ${outcome}`;
        },
      ),
      tool(
        "task_ask",
        "Ask a human a question; pauses the task.",
        z.object({ question: z.string() }),
        async ({ question }) => {
          this.ledger.transition(taskId, {
            type: "wait",
            waitingOn: "human",
            why: question,
            wakeAt: new Date(Date.now() + this.policy.tasks.park_after_ms).toISOString(),
          });
          return `task ${taskId} waiting on a human`;
        },
      ),
      tool(
        "set_wake",
        "Pause this task until an ISO-8601 time.",
        z.object({ wakeAt: FutureTime }),
        async ({ wakeAt }) => {
          this.ledger.transition(taskId, { type: "wait", waitingOn: "timer", wakeAt });
          return `paused until ${wakeAt}; the task picks up again then`;
        },
      ),
    ];
  }
}
