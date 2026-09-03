import { z } from "zod";
import { RefTagSchema, TaskTierSchema } from "../schemas/common";
import { defineTool, parseToolArgs, zodInputSchema } from "../schemas/tool";
import { EmptyArgsSchema, TaskAskArgsSchema, TaskReportArgsSchema } from "../schemas/tools";
import { ledgerView, transition } from "../ledger/tasks";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { pushEffect, type ToolsetContext } from "./toolset-types";
import {
  confirmFromRef,
  createTaskFromRef,
  finishExecutionTask,
  requireActiveTask,
  requireExecutionTask,
  steerFromRef,
} from "./toolset-tasks-util";

const TaskCreateParseSchema = z.object({
  title: z.string(),
  spec: z.string(),
  ref: z.string().optional(),
  tier: TaskTierSchema.optional(),
});

function taskCreateInputSchema(withRef: boolean) {
  return zodInputSchema(
    z.object({
      title: z.string(),
      spec: z.string(),
      ...(withRef ? { ref: RefTagSchema } : {}),
      tier: TaskTierSchema.optional(),
    }),
  );
}

const TaskSteerParseSchema = z.object({
  taskId: z.string(),
  kind: z.string(),
  text: z.string().optional(),
  ref: z.string().optional(),
});

const TaskCancelParseSchema = z.object({
  taskId: z.string(),
  report: z.string().optional(),
  ref: z.string().optional(),
});

const TaskConfirmParseSchema = z.object({
  taskId: z.string(),
  approve: z.boolean(),
  ref: z.string().optional(),
});

function taskSteerInputSchema(withRef: boolean) {
  return zodInputSchema(
    z.object({
      taskId: z.string(),
      kind: z.enum(["guidance", "pause", "resume"]),
      text: z.string().optional(),
      ...(withRef ? { ref: RefTagSchema } : {}),
    }),
  );
}

function taskCancelInputSchema(withRef: boolean) {
  return zodInputSchema(
    z.object({
      taskId: z.string(),
      report: z.string().optional(),
      ...(withRef ? { ref: RefTagSchema } : {}),
    }),
  );
}

function taskConfirmInputSchema(withRef: boolean) {
  return zodInputSchema(
    z.object({
      taskId: z.string(),
      approve: z.boolean(),
      ...(withRef ? { ref: RefTagSchema } : {}),
    }),
  );
}

export function taskCreateTool(ctx: ToolsetContext): DynamicTool {
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_create",
      description:
        "Record a new delegated task; a worker runs it and reports back to you. Input: { title, spec, ref, tier? }. ref is the [rN] tag of the conversation (or a message in it) this task is FOR — the worker's report comes home to that conversation, so pick the room that asked for the work, not whoever spoke last. tier is how hard the worker thinks: 'low' for routine mechanical work (tailing a ticket, fetching status), 'medium' for normal work, 'high' (default) for problems that need real thought. Write the spec as a full handoff — the worker starts with none of this conversation.",
      inputSchema: taskCreateInputSchema(withRef),
    },
    run: async (args) => {
      const parsed = parseToolArgs(TaskCreateParseSchema, args);
      if ("success" in parsed) return parsed;
      const { title, spec, ref, tier } = parsed.data;
      return createTaskFromRef(ctx, {
        title,
        spec,
        ...(ref !== undefined ? { ref } : {}),
        ...(tier !== undefined ? { tier } : {}),
      });
    },
  };
}

export function taskSteerTool(ctx: ToolsetContext): DynamicTool {
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_steer",
      description: `Attach guidance, a pause, or a resume to an existing task. Input: { taskId, kind: 'guidance'|'pause'|'resume', text?${withRef ? ", ref" : ""} }.${withRef ? " ref is the [rN] tag of the message asking for this." : ""}`,
      inputSchema: taskSteerInputSchema(withRef),
    },
    run: async (args) => {
      const parsed = parseToolArgs(TaskSteerParseSchema, args);
      if ("success" in parsed) return parsed;
      const { taskId, kind, text, ref } = parsed.data;
      if (kind !== "guidance" && kind !== "pause" && kind !== "resume") {
        return {
          success: false,
          output: `invalid_kind: task_steer only accepts guidance/pause/resume; use task_cancel or task_confirm for ${kind}`,
        };
      }
      const result = steerFromRef(ctx, {
        taskId,
        kind,
        payload: { text },
        ref,
        asking: "asking for this steer",
      });
      if (result.applied !== undefined) {
        pushEffect(ctx, {
          kind: "task_steered",
          taskId,
          steerKind: kind,
          applied: result.applied,
        });
      }
      return { success: result.success, output: result.output };
    },
  };
}

export function taskCancelTool(ctx: ToolsetContext): DynamicTool {
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_cancel",
      description: `Cancel a task. The report is a ledger record — it is NOT posted to the thread. If the room should hear that the work stopped, say it yourself with reply. Input: { taskId, report?${withRef ? ", ref" : ""} }.${withRef ? " ref is the [rN] tag of the message asking for the cancel." : ""}`,
      inputSchema: taskCancelInputSchema(withRef),
    },
    run: async (args) => {
      const parsed = parseToolArgs(TaskCancelParseSchema, args);
      if ("success" in parsed) return parsed;
      const { taskId, report, ref } = parsed.data;
      const result = steerFromRef(ctx, {
        taskId,
        kind: "cancel",
        payload: { report },
        ref,
        asking: "asking for the cancel",
      });
      if (result.applied !== undefined) {
        pushEffect(ctx, { kind: "task_cancelled", taskId, applied: result.applied });
      }
      return { success: result.success, output: result.output };
    },
  };
}

export function taskConfirmTool(ctx: ToolsetContext): DynamicTool {
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_confirm",
      description: withRef
        ? "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve, ref } — ref is the [rN] tag of the message where they granted or denied it; their word is the authority, so point at it."
        : "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve }.",
      inputSchema: taskConfirmInputSchema(withRef),
    },
    run: async (args) => {
      const parsed = parseToolArgs(TaskConfirmParseSchema, args);
      if ("success" in parsed) return parsed;
      const { taskId, approve, ref } = parsed.data;
      return confirmFromRef(
        ctx,
        {
          taskId,
          approve,
          ...(ref !== undefined ? { ref } : {}),
        },
        withRef,
      );
    },
  };
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
      transition(toolCtx.db, toolCtx.clock, scope.taskId, "waiting", {
        type: "yield_human",
        nudgeDeadline,
      });
      pushEffect(toolCtx, { kind: "task_asked", taskId: scope.taskId, question });
      return { success: true, output: `task ${scope.taskId} waiting on a human` };
    },
  )(ctx);
}
