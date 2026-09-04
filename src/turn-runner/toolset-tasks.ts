import { z } from "zod";
import { appendGuidance } from "../ledger/tasks-steer";
import { createTask, ledgerView, requireTask } from "../ledger/tasks-query";
import { tasks } from "../ledger/schema";
import { transition } from "../ledger/tasks-transition";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { IdentityConfig } from "../policy";
import type { Service } from "../service";
import type { WakePostContext } from "../service-wake-post";

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

export function taskCreateTool(
  host: Service,
  identity: IdentityConfig,
  post: WakePostContext | null,
): DynamicTool {
  return {
    spec: {
      name: "task_create",
      description:
        "Record a new delegated task; a worker runs it and reports back to you. Input: { title, spec, channel, thread_ts?, tier? }. channel and thread_ts are the conversation this task is FOR — the worker's report comes home there, so pick the room that asked for the work, not whoever spoke last. tier is how hard the worker thinks: 'low' for routine mechanical work (tailing a ticket, fetching status), 'medium' for normal work, 'high' (default) for problems that need real thought. Write the spec as a full handoff — the worker starts with none of this conversation.",
      inputSchema: z.toJSONSchema(TaskCreate),
    },
    run: async (raw) => {
      const task = createTask(host.db, { identityId: identity.id, ...TaskCreate.parse(raw) });
      post?.acts.add(`task:${task.id}`);
      return { success: true, output: JSON.stringify({ taskId: task.id, status: task.status }) };
    },
  };
}

export function taskSteerTool(
  host: Service,
  identity: IdentityConfig,
  post: WakePostContext | null,
): DynamicTool {
  return {
    spec: {
      name: "task_steer",
      description:
        "Attach guidance to an existing task; it is appended to the task's spec and a task waiting on a human resumes. Input: { taskId, text }.",
      inputSchema: z.toJSONSchema(TaskSteer),
    },
    run: async (raw) => {
      const { taskId, text } = TaskSteer.parse(raw);
      const task = appendGuidance(host.db, requireTask(host.db, taskId, identity.id), text);
      post?.acts.add(`steer:${taskId}`);
      return { success: true, output: JSON.stringify({ status: task.status }) };
    },
  };
}

export function taskCancelTool(
  host: Service,
  identity: IdentityConfig,
  post: WakePostContext | null,
): DynamicTool {
  return {
    spec: {
      name: "task_cancel",
      description:
        "Cancel a task. The report is for your own records, not the thread; if the room should hear that the work stopped, say it yourself with reply. Input: { taskId, report? }.",
      inputSchema: z.toJSONSchema(TaskCancel),
    },
    run: async (raw) => {
      const { taskId, report } = TaskCancel.parse(raw);
      const task = requireTask(host.db, taskId, identity.id);
      transition(host.db, taskId, {
        type: "finish",
        outcome: "cancelled",
        report: report ?? `Cancelled "${task.title}".`,
      });
      post?.acts.add(`cancel:${taskId}`);
      return { success: true, output: `task ${taskId} cancelled` };
    },
  };
}

export function taskQueryTool(host: Service, identity: IdentityConfig): DynamicTool {
  return {
    spec: {
      name: "task_query",
      description: "Read your open tasks and your recently finished ones.",
      inputSchema: z.toJSONSchema(z.object({})),
    },
    run: async () => ({
      success: true,
      output: JSON.stringify(ledgerView(host.db, identity.id)),
    }),
  };
}

export function taskCompleteTool(host: Service, taskId: string): DynamicTool {
  return {
    spec: {
      name: "task_complete",
      description:
        "Complete this task. Your report is handed back to the main mind, who tells the room in her own words — write it as a complete handoff: what you did, what you found, receipts (links/ids), and anything she should flag. Input: { report }.",
      inputSchema: z.toJSONSchema(Report),
    },
    run: async (raw) => {
      transition(host.db, taskId, { type: "finish", outcome: "done", ...Report.parse(raw) });
      return { success: true, output: `task ${taskId} completed` };
    },
  };
}

export function taskFailTool(host: Service, taskId: string): DynamicTool {
  return {
    spec: {
      name: "task_fail",
      description:
        "Fail this task honestly, stating what was attempted and what broke. Your report is handed back to the main mind, who tells the room — include the real cause and what would unblock it. Input: { report }.",
      inputSchema: z.toJSONSchema(Report),
    },
    run: async (raw) => {
      transition(host.db, taskId, { type: "finish", outcome: "failed", ...Report.parse(raw) });
      return { success: true, output: `task ${taskId} failed` };
    },
  };
}

export function taskAskTool(host: Service, taskId: string): DynamicTool {
  return {
    spec: {
      name: "task_ask",
      description:
        "Yield this task on a blocking question that isn't a specific consequential action. Your question is handed back to the main mind, who asks the room — phrase it so a human can answer it cold. Input: { question }.",
      inputSchema: z.toJSONSchema(Ask),
    },
    run: async (raw) => {
      const { question } = Ask.parse(raw);
      transition(host.db, taskId, {
        type: "wait",
        waitingOn: "human",
        why: question,
        wakeAt: new Date(Date.now() + host.policy.tasks.park_after_ms).toISOString(),
      });
      return { success: true, output: `task ${taskId} waiting on a human` };
    },
  };
}
