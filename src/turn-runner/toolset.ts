import { exposableForKind } from "../policy/broker";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolsetContext } from "./toolset-types";
import { gateToolCall } from "./toolset-gate";
import {
  taskAskTool,
  taskCancelTool,
  taskCompleteTool,
  taskConfirmTool,
  taskCreateTool,
  taskFailTool,
  taskQueryTool,
  taskSteerTool,
} from "./toolset-tasks";
import { reactTool, replyTool, setWakeTool, stepBackTool } from "./toolset-presence";
import { memoryRetractTool, memoryTierTool, memoryWriteTool, searchTool } from "./toolset-memory";
import { externalTools } from "./toolset-external";

export function buildToolset(ctx: ToolsetContext): DynamicTool[] {
  const factories: DynamicTool[] = [
    taskCreateTool(ctx),
    taskSteerTool(ctx),
    taskCancelTool(ctx),
    taskConfirmTool(ctx),
    taskQueryTool(ctx),
    replyTool(ctx),
    reactTool(ctx),
    stepBackTool(ctx),
    setWakeTool(ctx),
    taskCompleteTool(ctx),
    taskFailTool(ctx),
    taskAskTool(ctx),
    memoryWriteTool(ctx),
    memoryRetractTool(ctx),
    memoryTierTool(ctx),
    searchTool(ctx),
    ...externalTools(ctx),
  ];
  return factories
    .filter((tool) => exposableForKind(tool.spec.name, ctx.turnKind))
    .map((tool) => ({
      spec: tool.spec,
      run: (args) => gateToolCall(ctx, tool.spec.name, args, tool.run.bind(tool)),
    }));
}
