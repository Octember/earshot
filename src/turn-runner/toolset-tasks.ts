import { z } from "zod";
import { RefTagSchema, TaskTierSchema } from "../schemas/common";
import { defineTool } from "../schemas/tool";
import { EmptyArgsSchema, TaskAskArgsSchema, TaskReportArgsSchema } from "../schemas/tools";
import { ledgerView } from "../ledger/tasks-query";
import { transition } from "../ledger/tasks-transition";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolsetContext } from "./toolset-types";
import {
  confirmFromRef,
  createTaskFromRef,
  finishExecutionTask,
  activeTaskFor,
  steer,
} from "./toolset-tasks-util";

const TaskCreateArgs = z.object({
  title: z.string(),
  spec: z.string(),
  ref: RefTagSchema,
  tier: TaskTierSchema.optional(),
});
const TaskSteerArgs = z.object({ taskId: z.string(), text: z.string() });
const TaskCancelArgs = z.object({ taskId: z.string(), report: z.string().optional() });
const TaskConfirmArgs = z.object({ taskId: z.string(), approve: z.boolean(), ref: RefTagSchema });

export function taskCreateTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_create",
    "Record a new delegated task; a worker runs it and reports back to you. Input: { title, spec, ref, tier? }. ref is the [rN] tag of the conversation (or a message in it) this task is FOR — the worker's report comes home to that conversation, so pick the room that asked for the work, not whoever spoke last. tier is how hard the worker thinks: 'low' for routine mechanical work (tailing a ticket, fetching status), 'medium' for normal work, 'high' (default) for problems that need real thought. Write the spec as a full handoff — the worker starts with none of this conversation.",
    TaskCreateArgs,
    ({ title, spec, ref, tier }) =>
      createTaskFromRef(ctx, { title, spec, ref, ...(tier !== undefined ? { tier } : {}) }),
  );
}

export function taskSteerTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_steer",
    "Attach guidance to an existing task; it is appended to the task's spec and a task waiting on a human resumes. Input: { taskId, text }.",
    TaskSteerArgs,
    ({ taskId, text }) => {
      const result = steer(ctx, { taskId, kind: "guidance", text });
      if (result.applied !== undefined)
        ctx.effects.push({ kind: "task_steered", taskId, applied: result.applied });
      return { success: result.success, output: result.output };
    },
  );
}

export function taskCancelTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_cancel",
    "Cancel a task. The report is for your own records, not the thread; if the room should hear that the work stopped, say it yourself with reply. Input: { taskId, report? }.",
    TaskCancelArgs,
    ({ taskId, report }) => {
      const result = steer(ctx, { taskId, kind: "cancel", report });
      if (result.applied !== undefined)
        ctx.effects.push({ kind: "task_cancelled", taskId, applied: result.applied });
      return { success: result.success, output: result.output };
    },
  );
}

export function taskConfirmTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_confirm",
    "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve, ref } — ref is the [rN] tag of the message where they granted or denied it; their word is the authority, so point at it.",
    TaskConfirmArgs,
    ({ taskId, approve, ref }) => confirmFromRef(ctx, { taskId, approve, ref }),
  );
}

export function taskQueryTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_query",
    "Read your open tasks and your recently finished ones.",
    EmptyArgsSchema,
    async (_args) => ({
      success: true,
      output: JSON.stringify(ledgerView(ctx.db, ctx.identity.id)),
    }),
  );
}

export function taskCompleteTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_complete",
    "Complete this task. Your report is handed back to the main mind, who tells the room in her own words — write it as a complete handoff: what you did, what you found, receipts (links/ids), and anything she should flag. Input: { report }.",
    TaskReportArgsSchema,
    async ({ report }) => finishExecutionTask(ctx, report, "completed"),
  );
}

export function taskFailTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_fail",
    "Fail this task honestly, stating what was attempted and what broke. Your report is handed back to the main mind, who tells the room — include the real cause and what would unblock it. Input: { report }.",
    TaskReportArgsSchema,
    async ({ report }) => finishExecutionTask(ctx, report, "failed"),
  );
}

export function taskAskTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_ask",
    "Yield this task on a blocking question that isn't a specific consequential action. Your question is handed back to the main mind, who asks the room — phrase it so a human can answer it cold. Input: { question }.",
    TaskAskArgsSchema,
    async ({ question }) => {
      const task = activeTaskFor(ctx, "task_ask");
      if ("success" in task) return task;
      const parkDeadline = new Date(
        new Date(ctx.clock()).getTime() + ctx.parkAfterMs,
      ).toISOString();
      transition(ctx.db, ctx.clock, task.id, {
        type: "wait",
        waitingOn: "human",
        why: question,
        wakeAt: parkDeadline,
      });
      ctx.effects.push({ kind: "task_asked", taskId: task.id, question });
      return { success: true, output: `task ${task.id} waiting on a human` };
    },
  );
}
