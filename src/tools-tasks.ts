import { z } from "zod";
import { createTask, requireTask } from "./ledger/tasks-query";
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { tasks } from "./ledger/schema";
import { appendGuidance, transition } from "./ledger/tasks-transition";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { IdentityConfig } from "./policy";
import type { Service } from "./service";
import type { WakePostContext } from "./service-wake-post";

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
        "Delegate work to a background worker who reports back to you. channel and thread_ts are where the report comes home. Write the spec as a full handoff; the worker starts with none of this conversation. tier: low for mechanical work, medium normal, high (default) for real thought.",
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
      description: "Append guidance to a task's spec; a task waiting on a human resumes.",
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
      description: "Cancel a task. The report is for the ledger, not the room.",
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
      output: JSON.stringify({
        open: host.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.identityId, identity.id), ne(tasks.status, "done")))
          .orderBy(asc(tasks.openedAt))
          .all(),
        recentTerminals: host.db
          .select()
          .from(tasks)
          .where(and(eq(tasks.identityId, identity.id), eq(tasks.status, "done")))
          .orderBy(desc(tasks.updatedAt))
          .limit(10)
          .all(),
      }),
    }),
  };
}

export function taskCompleteTool(host: Service, taskId: string): DynamicTool {
  return {
    spec: {
      name: "task_complete",
      description:
        "Finish this task. The report is the handoff the main mind relays: what you did, what you found, receipts.",
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
      description: "Fail this task: what was attempted, what broke, what would unblock it.",
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
        "Park this task on a question only a human can answer; phrase it so they can answer cold.",
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
