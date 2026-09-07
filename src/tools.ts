import { tool, type DynamicTool } from "@bevyl-ai/agent-tools";
import { asc, desc, eq, ne } from "drizzle-orm";
import { inject, singleton } from "tsyringe";
import { z } from "zod";
import { LedgerService, TaskCreate, type Db } from "./ledger-service";
import { tasks } from "./ledger/schema";
import { POLICY, type Policy } from "./policy";

export const taskCreateTool = (ledger: LedgerService) =>
  tool(
    "task_create",
    "Delegate to a worker; the spec is its whole briefing.",
    TaskCreate,
    async (args) => {
      const task = ledger.createTask(args);
      return { id: task.id, status: task.status };
    },
  );

export const taskSteerTool = (ledger: LedgerService) =>
  tool(
    "task_steer",
    "Append to a task's spec.",
    z.object({ taskId: z.string(), text: z.string() }),
    async ({ taskId, text }) => {
      const task = ledger.appendGuidance(taskId, text);
      return { id: task.id, status: task.status };
    },
  );

export const taskCancelTool = (ledger: LedgerService) =>
  tool(
    "task_cancel",
    "Cancel a task.",
    z.object({ taskId: z.string(), report: z.string().optional() }),
    async ({ taskId, report }) => {
      const task = ledger.requireTask(taskId);
      ledger.transition(taskId, {
        type: "finish",
        outcome: "cancelled",
        report: report ?? `Cancelled "${task.title}".`,
      });
      return `task ${taskId} cancelled`;
    },
  );

export const taskQueryTool = (db: Db) =>
  tool("task_query", "Your open and recently finished tasks.", z.object({}), async () => ({
    open: db.query.tasks
      .findMany({ where: ne(tasks.status, "done"), orderBy: asc(tasks.openedAt) })
      .sync(),
    recentTerminals: db.query.tasks
      .findMany({ where: eq(tasks.status, "done"), orderBy: desc(tasks.updatedAt), limit: 10 })
      .sync(),
  }));

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
