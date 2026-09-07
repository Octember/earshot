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
    description:
      "Delegate work to a background worker who reports back to you. channel and thread_ts are where the report comes home. Write the spec as a full handoff; the worker starts with none of this conversation. tier: low for mechanical work, medium normal, high (default) for real thought.",
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
    description: "Append guidance to a task's spec; a task waiting on a human resumes.",
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
    description: "Cancel a task. The report is for the ledger, not the room.",
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
    description: "Read your open tasks and your recently finished ones.",
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
    description:
      "Finish this task. outcome done: the report is the handoff the main mind relays: what you did, what you found, receipts. outcome failed: what was attempted, what broke, what would unblock it.",
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
    description:
      "Park this task on a question only a human can answer; phrase it so they can answer cold.",
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
