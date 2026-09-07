import { z } from "zod";
import { asc, desc, eq, ne } from "drizzle-orm";
import { tasks, type Task } from "./ledger/schema";
import { TaskCreate, type Db, type LedgerService } from "./ledger-service";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { Policy } from "./policy";
import type { Acts } from "./acts";

const TaskSteer = z.object({ taskId: z.string(), text: z.string() });
const TaskCancel = z.object({ taskId: z.string(), report: z.string().optional() });
const Complete = z.object({ outcome: z.enum(["done", "failed"]), report: z.string() });
const Ask = z.object({ question: z.string() });

export function taskCreateTool(
  ledger: LedgerService,
  acts: Acts,
): DynamicTool<z.infer<typeof TaskCreate>, Pick<Task, "id" | "status">> {
  return {
    name: "task_create",
    description: "Delegate to a worker; the spec is its whole briefing.",
    input: TaskCreate,
    async run(args) {
      const task = ledger.createTask(args);
      acts.note(`task:${task.id}`);
      return { id: task.id, status: task.status };
    },
  };
}

export function taskSteerTool(
  ledger: LedgerService,
  acts: Acts,
): DynamicTool<z.infer<typeof TaskSteer>, Pick<Task, "id" | "status">> {
  return {
    name: "task_steer",
    description: "Append to a task's spec.",
    input: TaskSteer,
    async run({ taskId, text }) {
      const task = ledger.appendGuidance(taskId, text);
      acts.note(`steer:${taskId}`);
      return { id: task.id, status: task.status };
    },
  };
}

export function taskCancelTool(
  ledger: LedgerService,
  acts: Acts,
): DynamicTool<z.infer<typeof TaskCancel>, string> {
  return {
    name: "task_cancel",
    description: "Cancel a task.",
    input: TaskCancel,
    async run({ taskId, report }) {
      const task = ledger.requireTask(taskId);
      ledger.transition(taskId, {
        type: "finish",
        outcome: "cancelled",
        report: report ?? `Cancelled "${task.title}".`,
      });
      acts.note(`cancel:${taskId}`);
      return `task ${taskId} cancelled`;
    },
  };
}

export function taskQueryTool(
  db: Db,
): DynamicTool<Record<string, never>, { open: Task[]; recentTerminals: Task[] }> {
  return {
    name: "task_query",
    description: "Your open and recently finished tasks.",
    input: z.object({}),
    async run() {
      return {
        open: db.query.tasks
          .findMany({ where: ne(tasks.status, "done"), orderBy: asc(tasks.openedAt) })
          .sync(),
        recentTerminals: db.query.tasks
          .findMany({ where: eq(tasks.status, "done"), orderBy: desc(tasks.updatedAt), limit: 10 })
          .sync(),
      };
    },
  };
}

export function taskCompleteTool(
  ledger: LedgerService,
  taskId: string,
): DynamicTool<z.infer<typeof Complete>, string> {
  return {
    name: "task_complete",
    description: "Finish this task with a report.",
    input: Complete,
    async run({ outcome, report }) {
      ledger.transition(taskId, { type: "finish", outcome, report });
      return `task ${taskId} ${outcome}`;
    },
  };
}

export function taskAskTool(
  ledger: LedgerService,
  policy: Policy,
  taskId: string,
): DynamicTool<z.infer<typeof Ask>, string> {
  return {
    name: "task_ask",
    description: "Ask a human a question; pauses the task.",
    input: Ask,
    async run({ question }) {
      ledger.transition(taskId, {
        type: "wait",
        waitingOn: "human",
        why: question,
        wakeAt: new Date(Date.now() + policy.tasks.park_after_ms).toISOString(),
      });
      return `task ${taskId} waiting on a human`;
    },
  };
}
