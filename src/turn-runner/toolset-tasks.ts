import { asString, isRecord } from "../guard";
import { ledgerView, transition } from "../ledger/tasks";
import { pushEffect, type ToolFactory, type ToolsetContext } from "./toolset-types";
import {
  confirmFromRef,
  createTaskFromRef,
  finishExecutionTask,
  parseSteerKind,
  parseTaskTier,
  refFromArgs,
  requireActiveTask,
  requireExecutionTask,
  steerFromRef,
} from "./toolset-tasks-util";

export function taskCreateTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_create",
      description:
        "Record a new delegated task; a worker runs it and reports back to you. Input: { title, spec, ref, tier? }. ref is the [rN] tag of the conversation (or a message in it) this task is FOR — the worker's report comes home to that conversation, so pick the room that asked for the work, not whoever spoke last. tier is how hard the worker thinks: 'low' for routine mechanical work (tailing a ticket, fetching status), 'medium' for normal work, 'high' (default) for problems that need real thought. Write the spec as a full handoff — the worker starts with none of this conversation.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["title", "spec", "ref"],
        properties: {
          title: { type: "string" },
          spec: { type: "string" },
          ref: { type: "string", pattern: "^r\\d+$" },
          tier: { type: "string", enum: ["low", "medium", "high"] },
        },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const ref = refFromArgs(raw);
      const tier = parseTaskTier(raw.tier);
      return createTaskFromRef(ctx, {
        title: asString(raw.title),
        spec: asString(raw.spec),
        ...(ref !== undefined ? { ref } : {}),
        ...(tier !== undefined ? { tier } : {}),
      });
    },
  };
}

export function taskSteerTool(ctx: ToolsetContext): ToolFactory {
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_steer",
      description: `Attach guidance, a pause, or a resume to an existing task. Input: { taskId, kind: 'guidance'|'pause'|'resume', text?${withRef ? ", ref" : ""} }.${withRef ? " ref is the [rN] tag of the message asking for this." : ""}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: withRef ? ["taskId", "kind", "ref"] : ["taskId", "kind"],
        properties: {
          taskId: { type: "string" },
          kind: { type: "string", enum: ["guidance", "pause", "resume"] },
          text: { type: "string" },
          ...(withRef ? { ref: { type: "string", pattern: "^r\\d+$" } } : {}),
        },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const kind = parseSteerKind(raw.kind);
      if (kind !== "guidance" && kind !== "pause" && kind !== "resume") {
        return {
          success: false,
          output: `invalid_kind: task_steer only accepts guidance/pause/resume; use task_cancel or task_confirm for ${kind}`,
        };
      }
      const result = steerFromRef(ctx, {
        taskId: asString(raw.taskId),
        kind,
        payload: { text: typeof raw.text === "string" ? raw.text : undefined },
        ref: refFromArgs(raw),
        asking: "asking for this steer",
      });
      if (result.applied !== undefined) {
        pushEffect(ctx, {
          kind: "task_steered",
          taskId: asString(raw.taskId),
          steerKind: kind,
          applied: result.applied,
        });
      }
      return { success: result.success, output: result.output };
    },
  };
}

export function taskCancelTool(ctx: ToolsetContext): ToolFactory {
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_cancel",
      description: `Cancel a task. The report is a ledger record — it is NOT posted to the thread. If the room should hear that the work stopped, say it yourself with reply. Input: { taskId, report?${withRef ? ", ref" : ""} }.${withRef ? " ref is the [rN] tag of the message asking for the cancel." : ""}`,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: withRef ? ["taskId", "ref"] : ["taskId"],
        properties: {
          taskId: { type: "string" },
          report: { type: "string" },
          ...(withRef ? { ref: { type: "string", pattern: "^r\\d+$" } } : {}),
        },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const taskId = asString(raw.taskId);
      const result = steerFromRef(ctx, {
        taskId,
        kind: "cancel",
        payload: { report: typeof raw.report === "string" ? raw.report : undefined },
        ref: refFromArgs(raw),
        asking: "asking for the cancel",
      });
      if (result.applied !== undefined) {
        pushEffect(ctx, { kind: "task_cancelled", taskId, applied: result.applied });
      }
      return { success: result.success, output: result.output };
    },
  };
}

export function taskConfirmTool(ctx: ToolsetContext): ToolFactory {
  const withRef = !!ctx.refs;
  return {
    spec: {
      name: "task_confirm",
      description: withRef
        ? "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve, ref } — ref is the [rN] tag of the message where they granted or denied it; their word is the authority, so point at it."
        : "Resolve a pending confirmation on a task from a member's approve/deny. Input: { taskId, approve }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: withRef ? ["taskId", "approve", "ref"] : ["taskId", "approve"],
        properties: {
          taskId: { type: "string" },
          approve: { type: "boolean" },
          ...(withRef ? { ref: { type: "string", pattern: "^r\\d+$" } } : {}),
        },
      },
    },
    impl: async (args) => {
      const raw = isRecord(args) ? args : {};
      const ref = refFromArgs(raw);
      return confirmFromRef(
        ctx,
        {
          taskId: asString(raw.taskId),
          approve: raw.approve === true,
          ...(ref !== undefined ? { ref } : {}),
        },
        withRef,
      );
    },
  };
}

export function taskQueryTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_query",
      description: "Read your open tasks and your recently finished ones.",
      inputSchema: { type: "object", additionalProperties: false, properties: {} },
    },
    impl: async () => ({
      success: true,
      output: JSON.stringify(ledgerView(ctx.db, ctx.identity.id)),
    }),
  };
}

export function taskCompleteTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_complete",
      description:
        "Complete this task. Your report is handed back to the main mind, who tells the room in her own words — write it as a complete handoff: what you did, what you found, receipts (links/ids), and anything she should flag. Input: { report }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["report"],
        properties: { report: { type: "string" } },
      },
    },
    impl: async (args) =>
      finishExecutionTask(ctx, asString(isRecord(args) ? args.report : undefined), "completed"),
  };
}

export function taskFailTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_fail",
      description:
        "Fail this task honestly, stating what was attempted and what broke. Your report is handed back to the main mind, who tells the room — include the real cause and what would unblock it. Input: { report }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["report"],
        properties: { report: { type: "string" } },
      },
    },
    impl: async (args) =>
      finishExecutionTask(ctx, asString(isRecord(args) ? args.report : undefined), "failed"),
  };
}

export function taskAskTool(ctx: ToolsetContext): ToolFactory {
  return {
    spec: {
      name: "task_ask",
      description:
        "Yield this task on a blocking question that isn't a specific consequential action. Your question is handed back to the main mind, who asks the room — phrase it so a human can answer it cold. Input: { question }.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["question"],
        properties: { question: { type: "string" } },
      },
    },
    impl: async (args) => {
      const question = asString(isRecord(args) ? args.question : undefined);
      const blocked = requireExecutionTask(ctx, "task_ask") ?? requireActiveTask(ctx);
      if (blocked) return blocked;
      const nudgeDeadline = new Date(
        new Date(ctx.clock()).getTime() + ctx.nudgeAfterMs,
      ).toISOString();
      transition(ctx.db, ctx.clock, ctx.taskId!, "waiting", { type: "yield_human", nudgeDeadline });
      pushEffect(ctx, { kind: "task_asked", taskId: ctx.taskId!, question });
      return { success: true, output: `task ${ctx.taskId} waiting on a human` };
    },
  };
}
