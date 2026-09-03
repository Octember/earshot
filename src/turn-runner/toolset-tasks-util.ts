import { conversationOf } from "../ledger/conversations-refs";
import { provenanceOfRef, lastSpeakerIn } from "../ledger/conversations-render";
import { createTask } from "../ledger/tasks-query";
import { getTask, nextTaskId } from "../ledger/tasks-query";
import { steerTask, type Steer } from "../ledger/tasks-steer";
import { decideApproval } from "../ledger/outward-calls";
import { transition } from "../ledger/tasks-transition";
import type { Task } from "../ledger/schema";
import type { ToolResult } from "../schemas/tool";
import type { ToolsetContext } from "./toolset-types";

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
      output: "this task is waiting on a human — stop here and end the turn",
    };
  }
  return null;
}

export function steer(
  ctx: ToolsetContext,
  params: Steer,
): ToolResult & { task?: Task; applied?: boolean } {
  const result = steerTask(ctx.db, ctx.clock, ctx.identity.id, params);
  return {
    success: result.applied,
    output: result.reply ?? JSON.stringify({ status: result.task.status }),
    task: result.task,
    applied: result.applied,
  };
}

export function createTaskFromRef(
  ctx: ToolsetContext,
  args: { title: string; spec: string; ref: string; tier?: Task["tier"] },
): ToolResult {
  const target = ctx.refs.get(args.ref);
  if (!target)
    return {
      success: false,
      output: `"${args.ref}" is not a ref — home the task with the [rN] tag of the conversation its report belongs in`,
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
  ctx.effects.push({ kind: "task_created", taskId: task.id });
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
    type: "finish",
    outcome: outcome === "completed" ? "done" : "failed",
    report,
  });
  ctx.effects.push({
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
  args: { taskId: string; approve: boolean; ref: string },
): ToolResult {
  const target = ctx.refs.get(args.ref);
  if (!target?.ts)
    return {
      success: false,
      output: `"${args.ref}" is not a message ref — pass the [rN] tag of the member's own approve/deny line, not the conversation's`,
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
  const approverId = prov.principalId;
  const result = decideApproval(ctx.db, ctx.clock, {
    identityId: ctx.identity.id,
    taskId: args.taskId,
    principalId: approverId,
    approve: args.approve,
  });
  ctx.effects.push({
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
