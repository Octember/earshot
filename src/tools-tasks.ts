import { z } from "zod";
import { createTask, requireTask } from "./ledger/tasks-query";
import { asc, desc, eq, ne } from "drizzle-orm";
import { tasks, type Task } from "./ledger/schema";
import { appendGuidance, transition } from "./ledger/tasks-transition";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { Ledger } from "./ledger/db";
import type { Policy } from "./policy";
import type { Acts } from "./acts";

const TaskCreate = z.object({
  title: z.string(),
  spec: z.string(),
  channel: z.string(),
  thread_ts: z.string().optional(),
  tier: z.enum(tasks.tier.enumValues).optional(),
});
const TaskSteer = z.object({ taskId: z.string(), text: z.string() });
const TaskCancel = z.object({ taskId: z.string(), report: z.string().optional() });
const Complete = z.object({ outcome: z.enum(["done", "failed"]), report: z.string() });
const Ask = z.object({ question: z.string() });

export function taskCreateTool(
  db: Ledger,
  acts: Acts,
): DynamicTool<z.infer<typeof TaskCreate>, Pick<Task, "id" | "status">> {
  return {
    name: "task_create",
    description: "Delegate to a worker; the spec is its whole briefing.",
    input: TaskCreate,
    async run(args) {
      const task = createTask(db, args);
      acts.note(`task:${task.id}`);
      return { id: task.id, status: task.status };
    },
  };
}

export function taskSteerTool(
  db: Ledger,
  acts: Acts,
): DynamicTool<z.infer<typeof TaskSteer>, Pick<Task, "id" | "status">> {
  return {
    name: "task_steer",
    description: "Append to a task's spec.",
    input: TaskSteer,
    async run({ taskId, text }) {
      const task = appendGuidance(db, requireTask(db, taskId), text);
      acts.note(`steer:${taskId}`);
      return { id: task.id, status: task.status };
    },
  };
}

export function taskCancelTool(
  db: Ledger,
  acts: Acts,
): DynamicTool<z.infer<typeof TaskCancel>, string> {
  return {
    name: "task_cancel",
    description: "Cancel a task.",
    input: TaskCancel,
    async run({ taskId, report }) {
      const task = requireTask(db, taskId);
      transition(db, taskId, {
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
  db: Ledger,
): DynamicTool<Record<string, never>, { open: Task[]; recentTerminals: Task[] }> {
  return {
    name: "task_query",
    description: "Your open and recently finished tasks.",
    input: z.object({}),
    async run() {
      return {
        open: db
          .select()
          .from(tasks)
          .where(ne(tasks.status, "done"))
          .orderBy(asc(tasks.openedAt))
          .all(),
        recentTerminals: db
          .select()
          .from(tasks)
          .where(eq(tasks.status, "done"))
          .orderBy(desc(tasks.updatedAt))
          .limit(10)
          .all(),
      };
    },
  };
}

export function taskCompleteTool(
  db: Ledger,
  taskId: string,
): DynamicTool<z.infer<typeof Complete>, string> {
  return {
    name: "task_complete",
    description: "Finish this task with a report.",
    input: Complete,
    async run({ outcome, report }) {
      transition(db, taskId, { type: "finish", outcome, report });
      return `task ${taskId} ${outcome}`;
    },
  };
}

export function taskAskTool(
  db: Ledger,
  policy: Policy,
  taskId: string,
): DynamicTool<z.infer<typeof Ask>, string> {
  return {
    name: "task_ask",
    description: "Park this task on a question for a human.",
    input: Ask,
    async run({ question }) {
      transition(db, taskId, {
        type: "wait",
        waitingOn: "human",
        why: question,
        wakeAt: new Date(Date.now() + policy.tasks.park_after_ms).toISOString(),
      });
      return `task ${taskId} waiting on a human`;
    },
  };
}
