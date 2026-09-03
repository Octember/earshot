import { conversationOf } from "../ledger/conversations-refs";
import { provenanceOfRef, lastSpeakerIn } from "../ledger/conversations-render";
import { createTask } from "../ledger/tasks";
import { getTask, nextTaskId } from "../ledger/tasks-query";
import { steerTask } from "../ledger/tasks-steer";
import { resolveConfirmation } from "../ledger/tasks-confirmation";
import { transition } from "../ledger/tasks-transition";
import type { Task } from "../ledger/schema";
import type { ToolResult } from "../schemas/tool";
import { pushEffect, type ToolsetContext } from "./toolset-types";

export function steerSourceEvent(
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

export function resolveTaskHome(
  ctx: ToolsetContext,
  ref: string | undefined,
):
  | {
      ok: true;
      home: ReturnType<typeof conversationOf>;
      prov: NonNullable<ReturnType<typeof provenanceOfRef>>;
    }
  | { ok: false; output: string } {
  const target = ref ? ctx.refs?.get(ref) : undefined;
  if (!target) {
    return {
      ok: false,
      output: `"${ref ?? ""}" is not a ref — home the task with the [rN] tag of the conversation its report belongs in`,
    };
  }
  const home = conversationOf(target);
  const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
  if (!prov) {
    return {
      ok: false,
      output:
        "nothing recorded in that conversation yet — home the task with the [rN] tag of the message that asked for it",
    };
  }
  return { ok: true, home, prov };
}

export function resolveTaskSponsor(
  ctx: ToolsetContext,
  home: ReturnType<typeof conversationOf>,
  prov: NonNullable<ReturnType<typeof provenanceOfRef>>,
): { ok: true; sponsorId: string } | { ok: false; output: string } {
  const sponsorId = prov.principalId ?? lastSpeakerIn(ctx.db, ctx.identity.id, home);
  if (!sponsorId) {
    return {
      ok: false,
      output: "can't tell who this task is for — use the [rN] tag of the asking message",
    };
  }
  return { ok: true, sponsorId };
}

export function resolveConfirmApprover(
  ctx: ToolsetContext,
  ref: string | undefined,
): { ok: true; approverId: string } | { ok: false; output: string } {
  const target = ref ? ctx.refs?.get(ref) : undefined;
  if (!target?.ts) {
    return {
      ok: false,
      output: `"${ref ?? ""}" is not a message ref — pass the [rN] tag of the member's own approve/deny line, not the conversation's`,
    };
  }
  if (target.via === "search") {
    return {
      ok: false,
      output:
        "that line isn't from this conversation as you just read it — point at the [rN] tag of the approve/deny message in the rendered card",
    };
  }
  const prov = provenanceOfRef(ctx.db, ctx.identity.id, target);
  if (!prov?.principalId) {
    return {
      ok: false,
      output:
        "that line has no speaker to attribute the decision to — use the [rN] tag of the member's own message",
    };
  }
  return { ok: true, approverId: prov.principalId };
}

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

export function requireNonEmptyReport(report: string | undefined, verb: string): ToolResult | null {
  if (!report?.trim()) {
    return {
      success: false,
      output: `the report is the handoff — say what happened before ${verb}`,
    };
  }
  return null;
}

export function steerFromRef(
  ctx: ToolsetContext,
  params: {
    taskId: string;
    kind: "guidance" | "cancel" | "pause" | "resume";
    payload: Record<string, unknown>;
    ref?: string | undefined;
    asking: string;
  },
): ToolResult & { task?: Task; applied?: boolean } {
  const source = steerSourceEvent(ctx, params.ref, params.asking);
  if (typeof source !== "string") return { success: false, output: source.bounce };
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
  const homeResult = resolveTaskHome(ctx, args.ref);
  if (!homeResult.ok) return { success: false, output: homeResult.output };
  const sponsorResult = resolveTaskSponsor(ctx, homeResult.home, homeResult.prov);
  if (!sponsorResult.ok) return { success: false, output: sponsorResult.output };
  const task = createTask(ctx.db, ctx.clock, {
    id: nextTaskId(ctx.db),
    identityId: ctx.identity.id,
    title: args.title,
    spec: args.spec,
    sponsorId: sponsorResult.sponsorId,
    homeAnchor: { venueId: homeResult.home.venueId, threadRootId: homeResult.home.threadRootId },
    originEventId: homeResult.prov.eventId,
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
  const reportCheck = requireNonEmptyReport(
    report,
    outcome === "completed" ? "completing" : "failing",
  );
  if (reportCheck) return reportCheck;
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
    const approver = resolveConfirmApprover(ctx, args.ref);
    if (!approver.ok) return { success: false, output: approver.output };
    approverId = approver.approverId;
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
