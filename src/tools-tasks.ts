import { tool } from "@bevyl-ai/agent-tools";
import { asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Acts } from "./acts";
import { TaskCreate, type Db, type LedgerService } from "./ledger-service";
import { tasks } from "./ledger/schema";

export const taskCreateTool = (ledger: LedgerService, acts: Acts) =>
  tool(
    "task_create",
    "Delegate to a worker; the spec is its whole briefing.",
    TaskCreate,
    async (args) => {
      const task = ledger.createTask(args);
      acts.note(`task:${task.id}`);
      return { id: task.id, status: task.status };
    },
  );

export const taskSteerTool = (ledger: LedgerService, acts: Acts) =>
  tool(
    "task_steer",
    "Append to a task's spec.",
    z.object({ taskId: z.string(), text: z.string() }),
    async ({ taskId, text }) => {
      const task = ledger.appendGuidance(taskId, text);
      acts.note(`steer:${taskId}`);
      return { id: task.id, status: task.status };
    },
  );

export const taskCancelTool = (ledger: LedgerService, acts: Acts) =>
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
      acts.note(`cancel:${taskId}`);
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

export const taskCompleteTool = (ledger: LedgerService, taskId: string) =>
  tool(
    "task_complete",
    "Finish this task with a report.",
    z.object({ outcome: z.enum(["done", "failed"]), report: z.string() }),
    async ({ outcome, report }) => {
      ledger.transition(taskId, { type: "finish", outcome, report });
      return `task ${taskId} ${outcome}`;
    },
  );

export const taskAskTool = (ledger: LedgerService, parkAfterMs: number, taskId: string) =>
  tool(
    "task_ask",
    "Ask a human a question; pauses the task.",
    z.object({ question: z.string() }),
    async ({ question }) => {
      ledger.transition(taskId, {
        type: "wait",
        waitingOn: "human",
        why: question,
        wakeAt: new Date(Date.now() + parkAfterMs).toISOString(),
      });
      return `task ${taskId} waiting on a human`;
    },
  );
