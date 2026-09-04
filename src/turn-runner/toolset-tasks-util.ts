import { createTask } from "../ledger/tasks-query";
import { getTask, nextTaskId } from "../ledger/tasks-query";
import { steerTask, type Steer } from "../ledger/tasks-steer";
import { transition } from "../ledger/tasks-transition";
import type { Task } from "../ledger/schema";
import type { ToolsetContext } from "./toolset-types";

export type ToolResult = { success: boolean; output: string };

export function activeTaskFor(ctx: ToolsetContext, toolName: string): Task | ToolResult {
  if (!ctx.taskId) return { success: false, output: `${toolName} only works from inside a task` };
  const task = getTask(ctx.db, ctx.taskId);
  if (!task || task.status !== "active")
    return {
      success: false,
      output: "this task is waiting on a human — stop here and end the turn",
    };
  return task;
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

export function createTaskAt(
  ctx: ToolsetContext,
  args: { title: string; spec: string; channel: string; thread_ts?: string; tier?: Task["tier"] },
): ToolResult {
  const task = createTask(ctx.db, ctx.clock, {
    id: nextTaskId(ctx.db),
    identityId: ctx.identity.id,
    title: args.title,
    spec: args.spec,
    homeAnchor: { venueId: args.channel, threadRootId: args.thread_ts ?? null },
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
  const task = activeTaskFor(ctx, outcome === "completed" ? "task_complete" : "task_fail");
  if ("success" in task) return task;
  if (!report.trim())
    return {
      success: false,
      output: `the report is the handoff — say what happened before ${outcome === "completed" ? "completing" : "failing"}`,
    };
  transition(ctx.db, ctx.clock, task.id, {
    type: "finish",
    outcome: outcome === "completed" ? "done" : "failed",
    report,
  });
  ctx.effects.push({
    kind: outcome === "completed" ? "task_completed" : "task_failed",
    taskId: task.id,
  });
  return {
    success: true,
    output: `task ${task.id} ${outcome === "completed" ? "completed" : "failed"}`,
  };
}
