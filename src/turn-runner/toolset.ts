import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolsetContext } from "./toolset-types";
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
import { memoryRetractTool, memoryTierTool, memoryWriteTool, searchTool } from "./toolset-memory";

export function buildToolset(ctx: ToolsetContext): DynamicTool[] {
  const shared = [
    taskQueryTool(ctx),
    memoryWriteTool(ctx),
    memoryRetractTool(ctx),
    memoryTierTool(ctx),
    searchTool(ctx),
    ...ctx.external,
  ];
  return ctx.turnKind === "resident"
    ? [
        taskCreateTool(ctx),
        taskSteerTool(ctx),
        taskCancelTool(ctx),
        replyTool(ctx),
        reactTool(ctx),
        stepBackTool(ctx),
        ...shared,
      ]
    : [setWakeTool(ctx), taskCompleteTool(ctx), taskFailTool(ctx), taskAskTool(ctx), ...shared];
}
