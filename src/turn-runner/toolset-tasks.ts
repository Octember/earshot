import { asString, isRecord } from "../guard";
import {
  createTask,
  getTask,
  steerTask,
  resolveConfirmation,
  transition,
  ledgerView,
  nextTaskId,
} from "../ledger/tasks";
import { conversationOf, provenanceOfRef, lastSpeakerIn } from "../ledger/conversations";
import { pushEffect, type ToolFactory, type ToolsetContext } from "./toolset-types";

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
      const rawTier: "low" | "medium" | "high" | undefined =
        raw.tier === "low" || raw.tier === "medium" || raw.tier === "high" ? raw.tier : undefined;
      const toolArgs = {
        title: asString(raw.title),
        spec: asString(raw.spec),
        ref: typeof raw.ref === "string" ? raw.ref : undefined,
        tier: rawTier,
      };
      const target = toolArgs.ref ? ctx.refs?.get(toolArgs.ref) : undefined;
      if (!target) {
        return {
          success: false,
          output: `"${toolArgs.ref ?? ""}" is not a ref — home the task with the [rN] tag of the conversation its report belongs in`,
        };
      }
      const home = conversationOf(target);
      // Sponsor/origin bind to the ref's provenance, never a batch-level pick.
      const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
      if (!prov) {
        return {
          success: false,
          output:
            "nothing recorded in that conversation yet — home the task with the [rN] tag of the message that asked for it",
        };
      }
      const sponsorId = prov.principalId ?? lastSpeakerIn(ctx.db, ctx.identity.id, home);
      if (!sponsorId)
        return {
          success: false,
          output: "can't tell who this task is for — use the [rN] tag of the asking message",
        };
      const sponsor =
        ctx.resolvePrincipal?.(sponsorId) ??
        (ctx.principal?.id === sponsorId ? ctx.principal : undefined);
      const task = createTask(ctx.db, ctx.clock, {
        id: nextTaskId(ctx.db),
        identityId: ctx.identity.id,
        title: toolArgs.title,
        spec: toolArgs.spec,
        sponsorId,
        homeAnchor: { venueId: home.venueId, threadRootId: home.threadRootId },
        originEventId: prov.eventId,
        tier: toolArgs.tier,
        sponsorIsOperator: sponsor?.isOperator ?? false,
      });
      pushEffect(ctx, { kind: "task_created", taskId: task.id });
      return { success: true, output: JSON.stringify({ taskId: task.id, status: task.status }) };
    },
  };
}

// Steer/cancel source event: ref provenance when available, else turn origin. String = bounce.
function steerSourceEvent(
  ctx: ToolsetContext,
  ref: string | undefined,
  asking: string,
): string | { bounce: string } {
  if (ctx.refs) {
    const target = ref ? ctx.refs.get(ref) : undefined;
    if (!target)
      return { bounce: `"${ref ?? ""}" is not a ref — pass the [rN] tag of the message ${asking}` };
    const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
    if (!prov)
      return { bounce: "nothing recorded in that conversation yet — point at the message itself" };
    return prov.eventId;
  }
  if (!ctx.originEventId) return { bounce: "missing turn context" };
  return ctx.originEventId;
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
      const rawKind = raw.kind;
      if (
        rawKind !== "guidance" &&
        rawKind !== "cancel" &&
        rawKind !== "pause" &&
        rawKind !== "resume" &&
        rawKind !== "confirm"
      ) {
        return {
          success: false,
          output: `invalid_kind: task_steer only accepts guidance/pause/resume; use task_cancel or task_confirm for ${String(rawKind)}`,
        };
      }
      const toolArgs = {
        taskId: asString(raw.taskId),
        kind: rawKind,
        text: typeof raw.text === "string" ? raw.text : undefined,
        ref: typeof raw.ref === "string" ? raw.ref : undefined,
      };
      const source = steerSourceEvent(ctx, toolArgs.ref, "asking for this steer");
      if (typeof source !== "string") return { success: false, output: source.bounce };
      if (toolArgs.kind !== "guidance" && toolArgs.kind !== "pause" && toolArgs.kind !== "resume") {
        return {
          success: false,
          output: `invalid_kind: task_steer only accepts guidance/pause/resume; use task_cancel or task_confirm for ${toolArgs.kind}`,
        };
      }
      const result = steerTask(ctx.db, ctx.clock, {
        identityId: ctx.identity.id,
        taskId: toolArgs.taskId,
        kind: toolArgs.kind,
        payload: { text: toolArgs.text },
        sourceEventId: source,
      });
      pushEffect(ctx, {
        kind: "task_steered",
        taskId: toolArgs.taskId,
        steerKind: toolArgs.kind,
        applied: result.applied,
      });
      return {
        success: result.applied,
        output: result.reply ?? JSON.stringify({ status: result.task.status }),
      };
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
      const toolArgs = {
        taskId: asString(raw.taskId),
        report: typeof raw.report === "string" ? raw.report : undefined,
        ref: typeof raw.ref === "string" ? raw.ref : undefined,
      };
      const source = steerSourceEvent(ctx, toolArgs.ref, "asking for the cancel");
      if (typeof source !== "string") return { success: false, output: source.bounce };
      const result = steerTask(ctx.db, ctx.clock, {
        identityId: ctx.identity.id,
        taskId: toolArgs.taskId,
        kind: "cancel",
        payload: { report: toolArgs.report },
        sourceEventId: source,
      });
      pushEffect(ctx, { kind: "task_cancelled", taskId: toolArgs.taskId, applied: result.applied });
      return {
        success: result.applied,
        output: result.reply ?? JSON.stringify({ status: result.task.status }),
      };
    },
  };
}

export function taskConfirmTool(ctx: ToolsetContext): ToolFactory {
  // Approver is the speaker of the ref'd message; ref-less contexts keep turn principal.
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
      const toolArgs = {
        taskId: asString(raw.taskId),
        approve: raw.approve === true,
        ref: typeof raw.ref === "string" ? raw.ref : undefined,
      };
      let approverId: string;
      if (withRef) {
        const target = toolArgs.ref ? ctx.refs?.get(toolArgs.ref) : undefined;
        // Only a message ref names a speaker; conversation refs rejected (batch-tail guess).
        if (!target?.ts) {
          return {
            success: false,
            output: `"${toolArgs.ref ?? ""}" is not a message ref — pass the [rN] tag of the member's own approve/deny line, not the conversation's`,
          };
        }
        // Unread targets rejected (no bounce): cannot record authorization from unread lines.
        if (target.via === "search") {
          return {
            success: false,
            output:
              "that line isn't from this conversation as you just read it — point at the [rN] tag of the approve/deny message in the rendered card",
          };
        }
        const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
        if (!prov?.principalId) {
          return {
            success: false,
            output:
              "that line has no speaker to attribute the decision to — use the [rN] tag of the member's own message",
          };
        }
        approverId = prov.principalId;
      } else {
        if (!ctx.principal) return { success: false, output: "missing principal for task_confirm" };
        approverId = ctx.principal.id;
      }
      const result = resolveConfirmation(ctx.db, ctx.clock, {
        identityId: ctx.identity.id,
        taskId: toolArgs.taskId,
        principalId: approverId,
        approve: toolArgs.approve,
      });
      pushEffect(ctx, {
        kind: "confirmation_resolved",
        taskId: toolArgs.taskId,
        approve: toolArgs.approve,
        applied: result.applied,
      });
      return {
        success: result.applied,
        output: result.reply ?? JSON.stringify({ status: result.task.status }),
      };
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
    impl: async () => {
      const view = ledgerView(ctx.db, ctx.identity.id);
      return { success: true, output: JSON.stringify(view) };
    },
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
    impl: async (args) => {
      const toolArgs = { report: asString(isRecord(args) ? args.report : undefined) };
      if (!ctx.taskId)
        return {
          success: false,
          output: "task_complete is only available to an execution's own turns",
        };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return {
          success: false,
          output: "this task is paused waiting on a human go-ahead — stop here and end the turn",
        };
      }
      if (!toolArgs.report?.trim())
        return {
          success: false,
          output: "the report is the handoff — say what happened before completing",
        };
      transition(ctx.db, ctx.clock, ctx.taskId, "done", {
        type: "completed",
        report: toolArgs.report,
      });
      pushEffect(ctx, { kind: "task_completed", taskId: ctx.taskId });
      return { success: true, output: `task ${ctx.taskId} completed` };
    },
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
    impl: async (args) => {
      const toolArgs = { report: asString(isRecord(args) ? args.report : undefined) };
      if (!ctx.taskId)
        return {
          success: false,
          output: "task_fail is only available to an execution's own turns",
        };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return {
          success: false,
          output: "this task is paused waiting on a human go-ahead — stop here and end the turn",
        };
      }
      if (!toolArgs.report?.trim())
        return {
          success: false,
          output: "the report is the handoff — say what happened before failing",
        };
      transition(ctx.db, ctx.clock, ctx.taskId, "failed", {
        type: "failed",
        report: toolArgs.report,
      });
      pushEffect(ctx, { kind: "task_failed", taskId: ctx.taskId });
      return { success: true, output: `task ${ctx.taskId} failed` };
    },
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
      const toolArgs = { question: asString(isRecord(args) ? args.question : undefined) };
      if (!ctx.taskId)
        return { success: false, output: "task_ask is only available to an execution's own turns" };
      const live = getTask(ctx.db, ctx.taskId);
      if (live && live.status !== "active") {
        return {
          success: false,
          output: "this task is paused waiting on a human go-ahead — stop here and end the turn",
        };
      }
      const nudgeDeadline = new Date(
        new Date(ctx.clock()).getTime() + ctx.nudgeAfterMs,
      ).toISOString();
      transition(ctx.db, ctx.clock, ctx.taskId, "waiting", { type: "yield_human", nudgeDeadline });
      pushEffect(ctx, { kind: "task_asked", taskId: ctx.taskId, question: toolArgs.question });
      return { success: true, output: `task ${ctx.taskId} waiting on a human` };
    },
  };
}
