import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ExecutionContext, ResidentContext } from "./toolset-types";
import {
  taskAskTool,
  taskCancelTool,
  taskCompleteTool,
  taskCreateTool,
  taskFailTool,
  taskQueryTool,
  taskSteerTool,
} from "./toolset-tasks";
import { reactTool, replyTool, setWakeTool, stepBackTool } from "./toolset-presence";

export function residentToolset(ctx: ResidentContext): DynamicTool[] {
  return [
    taskCreateTool(ctx),
    taskSteerTool(ctx),
    taskCancelTool(ctx),
    replyTool(ctx),
    reactTool(ctx),
    stepBackTool(ctx),
    taskQueryTool(ctx),
    ...ctx.external,
  ];
}

export function executionToolset(ctx: ExecutionContext): DynamicTool[] {
  return [
    setWakeTool(ctx),
    taskCompleteTool(ctx),
    taskFailTool(ctx),
    taskAskTool(ctx),
    taskQueryTool(ctx),
    ...ctx.external,
  ];
}
