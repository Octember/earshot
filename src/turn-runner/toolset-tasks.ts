import { z } from "zod";
import { RefTagSchema, TaskTierSchema } from "../schemas/common";
import { defineTool, zodInputSchema } from "../schemas/tool";
import { EmptyArgsSchema, TaskAskArgsSchema, TaskReportArgsSchema } from "../schemas/tools";
import { ledgerView } from "../ledger/tasks-query";
import { transition } from "../ledger/tasks-transition";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolsetContext } from "./toolset-types";
import {
  confirmFromRef,
  createTaskFromRef,
  finishExecutionTask,
  requireActiveTask,
  requireExecutionTask,
  steerFromRef,
} from "./toolset-tasks-util";

const TaskCreateArgs = z.object({
  title: z.string(),
  spec: z.string(),
  tier: TaskTierSchema.optional(),
});
const TaskSteerArgs = z.object({
  taskId: z.string(),
  kind: z.enum(["guidance", "pause", "resume"]),
  text: z.string().optional(),
});
const TaskCancelArgs = z.object({ taskId: z.string(), report: z.string().optional() });
const TaskConfirmArgs = z.object({ taskId: z.string(), approve: z.boolean() });
const LooseRef = { ref: z.string().optional() };
const exposed = (base: z.ZodObject<z.ZodRawShape>, withRef: boolean) =>
  zodInputSchema(withRef ? base.extend({ ref: RefTagSchema }) : base);

export function taskCreateTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_create",
    "Record a new delegated task; a worker runs it and reports back to you. Input: { title, spec, ref, tier? }. ref is the [rN] tag of the conversation (or a message in it) this task is FOR — the worker's report comes home to that conversation, so pick the room that asked for the work, not whoever spoke last. tier is how hard the worker thinks: 'low' for routine mechanical work (tailing a ticket, fetching status), 'medium' for normal work, 'high' (default) for problems that need real thought. Write the spec as a full handoff — the worker starts with none of this conversation.",
    TaskCreateArgs.extend(LooseRef),
    ({ title, spec, ref, tier }, toolCtx) =>
      createTaskFromRef(toolCtx, {
        title,
        spec,
        ...(ref !== undefined ? { ref } : {}),
        ...(tier !== undefined ? { tier } : {}),
      }),
    exposed(TaskCreateArgs, !!ctx.refs),
  )(ctx);
}

export function taskSteerTool(ctx: ToolsetContext): DynamicTool {
  const withRef = !!ctx.refs;
  return defineTool(
    "task_steer",
    `Attach guidance, a pause, or a resume to an existing task. Input: { taskId, kind: 'guidance'|'pause'|'resume', text?${withRef ? ", ref" : ""} }.${withRef ? " ref is the [rN] tag of the message asking for this." : ""}`,
    TaskSteerArgs.extend(LooseRef),
    ({ taskId, kind, text, ref }, toolCtx) => {
      const result = steerFromRef(toolCtx, {
        taskId,
        kind,
        payload: { text },
        ref,
        asking: "asking for this steer",
      });
      if (result.applied !== undefined)
        toolCtx.effects.push({
          kind: "task_steered",
          taskId,
          steerKind: kind,
          applied: result.applied,
        });
      return { success: result.success, output: result.output };
    },
    exposed(TaskSteerArgs, withRef),
  )(ctx);
}

export function taskCancelTool(ctx: ToolsetContext): DynamicTool {
  const withRef = !!ctx.refs;
  return defineTool(
    "task_cancel",
    `Cancel a task. The report is a ledger record — it is NOT posted to the thread. If the room should hear that the work stopped, say it yourself with reply. Input: { taskId, report?${withRef ? ", ref" : ""} }.${withRef ? " ref is the [rN] tag of the message asking for the cancel." : ""}`,
    TaskCancelArgs.extend(LooseRef),
    ({ taskId, report, ref }, toolCtx) => {
      const result = steerFromRef(toolCtx, {
        taskId,
        kind: "cancel",
        payload: { report },
        ref,
        asking: "asking for the cancel",
      });
      if (result.applied !== undefined)
        toolCtx.effects.push({ kind: "task_cancelled", taskId, applied: result.applied });
      return { success: result.success, output: result.output };
    },
    exposed(TaskCancelArgs, withRef),
  )(ctx);
}

export function taskConfirmTool(ctx: ToolsetContext): DynamicTool {
  const withRef = !!ctx.refs;
  return defineTool(
    "task_confirm",
    withRef
      ? "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve, ref } — ref is the [rN] tag of the message where they granted or denied it; their word is the authority, so point at it."
      : "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve }.",
    TaskConfirmArgs.extend(LooseRef),
    ({ taskId, approve, ref }, toolCtx) =>
      confirmFromRef(toolCtx, { taskId, approve, ...(ref !== undefined ? { ref } : {}) }, withRef),
    exposed(TaskConfirmArgs, withRef),
  )(ctx);
}

export function taskQueryTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_query",
    "Read your open tasks and your recently finished ones.",
    EmptyArgsSchema,
    async (_args, toolCtx) => ({
      success: true,
      output: JSON.stringify(ledgerView(toolCtx.db, toolCtx.identity.id)),
    }),
  )(ctx);
}

export function taskCompleteTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_complete",
    "Complete this task. Your report is handed back to the main mind, who tells the room in her own words — write it as a complete handoff: what you did, what you found, receipts (links/ids), and anything she should flag. Input: { report }.",
    TaskReportArgsSchema,
    async ({ report }, toolCtx) => finishExecutionTask(toolCtx, report, "completed"),
  )(ctx);
}

export function taskFailTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_fail",
    "Fail this task honestly, stating what was attempted and what broke. Your report is handed back to the main mind, who tells the room — include the real cause and what would unblock it. Input: { report }.",
    TaskReportArgsSchema,
    async ({ report }, toolCtx) => finishExecutionTask(toolCtx, report, "failed"),
  )(ctx);
}

export function taskAskTool(ctx: ToolsetContext): DynamicTool {
  return defineTool(
    "task_ask",
    "Yield this task on a blocking question that isn't a specific consequential action. Your question is handed back to the main mind, who asks the room — phrase it so a human can answer it cold. Input: { question }.",
    TaskAskArgsSchema,
    async ({ question }, toolCtx) => {
      const scope = requireExecutionTask(toolCtx, "task_ask");
      if ("success" in scope) return scope;
      const active = requireActiveTask(toolCtx);
      if (active) return active;
      const nudgeDeadline = new Date(
        new Date(toolCtx.clock()).getTime() + toolCtx.nudgeAfterMs,
      ).toISOString();
      transition(toolCtx.db, toolCtx.clock, scope.taskId, {
        type: "yield_human",
        nudgeDeadline,
      });
      toolCtx.effects.push({ kind: "task_asked", taskId: scope.taskId, question });
      return { success: true, output: `task ${scope.taskId} waiting on a human` };
    },
  )(ctx);
}
