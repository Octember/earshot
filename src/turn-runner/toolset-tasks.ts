import { z } from "zod";
import { createTask, ledgerView, nextTaskId } from "../ledger/tasks-query";
import { tasks } from "../ledger/schema";
import { steerTask } from "../ledger/tasks-steer";
import { transition } from "../ledger/tasks-transition";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ExecutionContext, TurnContext } from "./toolset-types";

const TaskCreate = z.object({
  title: z.string(),
  spec: z.string(),
  channel: z.string(),
  thread_ts: z.string().optional(),
  tier: z.enum(tasks.tier.enumValues).optional(),
});
const TaskSteer = z.object({ taskId: z.string(), text: z.string() });
const TaskCancel = z.object({ taskId: z.string(), report: z.string().optional() });
const Report = z.object({
  report: z.string().min(1, "the report is the handoff — say what happened"),
});
const Ask = z.object({ question: z.string() });

export function taskCreateTool(ctx: TurnContext): DynamicTool {
  return {
    spec: {
      name: "task_create",
      description:
        "Record a new delegated task; a worker runs it and reports back to you. Input: { title, spec, channel, thread_ts?, tier? }. channel and thread_ts are the conversation this task is FOR — the worker's report comes home there, so pick the room that asked for the work, not whoever spoke last. tier is how hard the worker thinks: 'low' for routine mechanical work (tailing a ticket, fetching status), 'medium' for normal work, 'high' (default) for problems that need real thought. Write the spec as a full handoff — the worker starts with none of this conversation.",
      inputSchema: z.toJSONSchema(TaskCreate),
    },
    run: async (raw) => {
      const { title, spec, channel, thread_ts, tier } = TaskCreate.parse(raw);
      const task = createTask(ctx.db, ctx.clock, {
        id: nextTaskId(ctx.db),
        identityId: ctx.identity.id,
        title,
        spec,
        homeAnchor: { venueId: channel, threadRootId: thread_ts ?? null },
        tier,
      });
      ctx.effects.push({ kind: "task_created", taskId: task.id });
      return { success: true, output: JSON.stringify({ taskId: task.id, status: task.status }) };
    },
  };
}

export function taskSteerTool(ctx: TurnContext): DynamicTool {
  return {
    spec: {
      name: "task_steer",
      description:
        "Attach guidance to an existing task; it is appended to the task's spec and a task waiting on a human resumes. Input: { taskId, text }.",
      inputSchema: z.toJSONSchema(TaskSteer),
    },
    run: async (raw) => {
      const { taskId, text } = TaskSteer.parse(raw);
      const result = steerTask(ctx.db, ctx.clock, ctx.identity.id, {
        taskId,
        kind: "guidance",
        text,
      });
      ctx.effects.push({ kind: "task_steered", taskId, applied: result.applied });
      return {
        success: result.applied,
        output: result.reply ?? JSON.stringify({ status: result.task.status }),
      };
    },
  };
}

export function taskCancelTool(ctx: TurnContext): DynamicTool {
  return {
    spec: {
      name: "task_cancel",
      description:
        "Cancel a task. The report is for your own records, not the thread; if the room should hear that the work stopped, say it yourself with reply. Input: { taskId, report? }.",
      inputSchema: z.toJSONSchema(TaskCancel),
    },
    run: async (raw) => {
      const { taskId, report } = TaskCancel.parse(raw);
      const result = steerTask(ctx.db, ctx.clock, ctx.identity.id, {
        taskId,
        kind: "cancel",
        report,
      });
      ctx.effects.push({ kind: "task_cancelled", taskId, applied: result.applied });
      return {
        success: result.applied,
        output: result.reply ?? JSON.stringify({ status: result.task.status }),
      };
    },
  };
}

export function taskQueryTool(ctx: TurnContext): DynamicTool {
  return {
    spec: {
      name: "task_query",
      description: "Read your open tasks and your recently finished ones.",
      inputSchema: z.toJSONSchema(z.object({})),
    },
    run: async () => ({
      success: true,
      output: JSON.stringify(ledgerView(ctx.db, ctx.identity.id)),
    }),
  };
}

export function taskCompleteTool(ctx: ExecutionContext): DynamicTool {
  return {
    spec: {
      name: "task_complete",
      description:
        "Complete this task. Your report is handed back to the main mind, who tells the room in her own words — write it as a complete handoff: what you did, what you found, receipts (links/ids), and anything she should flag. Input: { report }.",
      inputSchema: z.toJSONSchema(Report),
    },
    run: async (raw) => {
      const { report } = Report.parse(raw);
      transition(ctx.db, ctx.clock, ctx.taskId, { type: "finish", outcome: "done", report });
      ctx.effects.push({ kind: "task_completed", taskId: ctx.taskId });
      return { success: true, output: `task ${ctx.taskId} completed` };
    },
  };
}

export function taskFailTool(ctx: ExecutionContext): DynamicTool {
  return {
    spec: {
      name: "task_fail",
      description:
        "Fail this task honestly, stating what was attempted and what broke. Your report is handed back to the main mind, who tells the room — include the real cause and what would unblock it. Input: { report }.",
      inputSchema: z.toJSONSchema(Report),
    },
    run: async (raw) => {
      const { report } = Report.parse(raw);
      transition(ctx.db, ctx.clock, ctx.taskId, { type: "finish", outcome: "failed", report });
      ctx.effects.push({ kind: "task_failed", taskId: ctx.taskId });
      return { success: true, output: `task ${ctx.taskId} failed` };
    },
  };
}

export function taskAskTool(ctx: ExecutionContext): DynamicTool {
  return {
    spec: {
      name: "task_ask",
      description:
        "Yield this task on a blocking question that isn't a specific consequential action. Your question is handed back to the main mind, who asks the room — phrase it so a human can answer it cold. Input: { question }.",
      inputSchema: z.toJSONSchema(Ask),
    },
    run: async (raw) => {
      const { question } = Ask.parse(raw);
      transition(ctx.db, ctx.clock, ctx.taskId, {
        type: "wait",
        waitingOn: "human",
        why: question,
        wakeAt: new Date(Date.parse(ctx.clock()) + ctx.parkAfterMs).toISOString(),
      });
      ctx.effects.push({ kind: "task_asked", taskId: ctx.taskId, question });
      return { success: true, output: `task ${ctx.taskId} waiting on a human` };
    },
  };
}
