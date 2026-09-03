// Standard toolset: every call gated through broker decide(); posting scope-checked per turn kind.
import { exposableForKind } from "../policy/broker";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { gated, type ToolsetContext } from "./toolset-types";
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
import { auditQueryTool, externalTools } from "./toolset-external";

export function buildToolset(ctx: ToolsetContext): DynamicTool[] {
  const audit = auditQueryTool(ctx);
  // Per-kind restriction at registration; broker gate wraps every exposed tool.
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
    ...(audit ? [audit] : []),
    ...externalTools(ctx),
  ];
  return factories
    .filter((tool) => exposableForKind(tool.spec.name, ctx.turnKind))
    .map((tool) => ({ spec: tool.spec, run: gated(ctx, tool.spec.name, tool.run.bind(tool)) }));
}
