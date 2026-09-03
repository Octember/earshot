import { conversationOf } from "../ledger/conversations-refs";
import { provenanceOfRef, lastSpeakerIn } from "../ledger/conversations-render";
import { createTask } from "../ledger/tasks";
import { getTask, nextTaskId } from "../ledger/tasks-query";
import { steerTask } from "../ledger/tasks-steer";
import { resolveConfirmation } from "../ledger/tasks-confirmation";
import { transition } from "../ledger/tasks-transition";
import type { SteerPayload, Task } from "../ledger/schema";
import type { ToolResult } from "../schemas/tool";
import { pushEffect, type ToolsetContext } from "./toolset-types";

export function requireExecutionTask(
  ctx: ToolsetContext,
  toolName: string,
): { taskId: string } | ToolResult {
  if (!ctx.taskId)
    return { success: false, output: `${toolName} is only available to an execution's own turns` };
  return { taskId: ctx.taskId };
}

export function requireActiveTask(ctx: ToolsetContext): ToolResult | null {
  if (!ctx.taskId) return null;
  const live = getTask(ctx.db, ctx.taskId);
  if (live && live.status !== "active") {
    return {
      success: false,
      output: "this task is paused waiting on a human go-ahead — stop here and end the turn",
    };
  }
  return null;
}

export function steerFromRef(
  ctx: ToolsetContext,
  params: {
    taskId: string;
    kind: "guidance" | "cancel" | "pause" | "resume";
    payload: SteerPayload;
    ref?: string | undefined;
    asking: string;
  },
): ToolResult & { task?: Task; applied?: boolean } {
  let source: string;
  if (ctx.refs) {
    const target = params.ref ? ctx.refs.get(params.ref) : undefined;
    if (!target)
      return {
        success: false,
        output: `"${params.ref ?? ""}" is not a ref — pass the [rN] tag of the message ${params.asking}`,
      };
    const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
    if (!prov)
      return {
        success: false,
        output: "nothing recorded in that conversation yet — point at the message itself",
      };
    source = prov.eventId;
  } else {
    if (!ctx.originEventId) return { success: false, output: "missing turn context" };
    source = ctx.originEventId;
  }
  const result = steerTask(ctx.db, ctx.clock, {
    identityId: ctx.identity.id,
    taskId: params.taskId,
    kind: params.kind,
    payload: params.payload,
    sourceEventId: source,
  });
  return {
    success: result.applied,
    output: result.reply ?? JSON.stringify({ status: result.task.status }),
    task: result.task,
    applied: result.applied,
  };
}

export function createTaskFromRef(
  ctx: ToolsetContext,
  args: { title: string; spec: string; ref?: string; tier?: Task["tier"] },
): ToolResult {
  const target = args.ref ? ctx.refs?.get(args.ref) : undefined;
  if (!target)
    return {
      success: false,
      output: `"${args.ref ?? ""}" is not a ref — home the task with the [rN] tag of the conversation its report belongs in`,
    };
  const home = conversationOf(target);
  const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
  if (!prov)
    return {
      success: false,
      output:
        "nothing recorded in that conversation yet — home the task with the [rN] tag of the message that asked for it",
    };
  const sponsorId = prov.principalId ?? lastSpeakerIn(ctx.db, ctx.identity.id, home);
  if (!sponsorId)
    return {
      success: false,
      output: "can't tell who this task is for — use the [rN] tag of the asking message",
    };
  const task = createTask(ctx.db, ctx.clock, {
    id: nextTaskId(ctx.db),
    identityId: ctx.identity.id,
    title: args.title,
    spec: args.spec,
    sponsorId,
    homeAnchor: home,
    originEventId: prov.eventId,
    tier: args.tier,
  });
  pushEffect(ctx, { kind: "task_created", taskId: task.id });
  return { success: true, output: JSON.stringify({ taskId: task.id, status: task.status }) };
}

export function finishExecutionTask(
  ctx: ToolsetContext,
  report: string,
  outcome: "completed" | "failed",
): ToolResult {
  const scope = requireExecutionTask(ctx, outcome === "completed" ? "task_complete" : "task_fail");
  if ("success" in scope) return scope;
  const active = requireActiveTask(ctx);
  if (active) return active;
  if (!report.trim())
    return {
      success: false,
      output: `the report is the handoff — say what happened before ${outcome === "completed" ? "completing" : "failing"}`,
    };
  transition(ctx.db, ctx.clock, scope.taskId, {
    type: outcome,
    report,
  });
  pushEffect(ctx, {
    kind: outcome === "completed" ? "task_completed" : "task_failed",
    taskId: scope.taskId,
  });
  return {
    success: true,
    output: `task ${scope.taskId} ${outcome === "completed" ? "completed" : "failed"}`,
  };
}

export function confirmFromRef(
  ctx: ToolsetContext,
  args: { taskId: string; approve: boolean; ref?: string },
  withRef: boolean,
): ToolResult {
  let approverId: string;
  if (withRef) {
    const target = args.ref ? ctx.refs?.get(args.ref) : undefined;
    if (!target?.ts)
      return {
        success: false,
        output: `"${args.ref ?? ""}" is not a message ref — pass the [rN] tag of the member's own approve/deny line, not the conversation's`,
      };
    if (target.via === "search")
      return {
        success: false,
        output:
          "that line isn't from this conversation as you just read it — point at the [rN] tag of the approve/deny message in the rendered card",
      };
    const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
    if (!prov?.principalId)
      return {
        success: false,
        output:
          "that line has no speaker to attribute the decision to — use the [rN] tag of the member's own message",
      };
    approverId = prov.principalId;
  } else {
    if (!ctx.principal) return { success: false, output: "missing principal for task_confirm" };
    approverId = ctx.principal.id;
  }
  const result = resolveConfirmation(ctx.db, ctx.clock, {
    identityId: ctx.identity.id,
    taskId: args.taskId,
    principalId: approverId,
    approve: args.approve,
  });
  pushEffect(ctx, {
    kind: "confirmation_resolved",
    taskId: args.taskId,
    approve: args.approve,
    applied: result.applied,
  });
  return {
    success: result.applied,
    output: result.reply ?? JSON.stringify({ status: result.task.status }),
  };
}
