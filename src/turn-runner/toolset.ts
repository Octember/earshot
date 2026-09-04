import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { IdentityConfig } from "../policy";
import type { Service } from "../service";
import type { WakePostContext } from "../service-wake-post";
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

export function residentToolset(
  host: Service,
  identity: IdentityConfig,
  post: WakePostContext | null,
): DynamicTool[] {
  return [
    taskCreateTool(host, identity, post),
    taskSteerTool(host, identity, post),
    taskCancelTool(host, identity, post),
    replyTool(identity, post),
    reactTool(identity, post),
    stepBackTool(host, identity, post),
    taskQueryTool(host, identity),
    ...host.tools,
  ];
}

export function executionToolset(
  host: Service,
  identity: IdentityConfig,
  taskId: string,
): DynamicTool[] {
  return [
    setWakeTool(host, taskId),
    taskCompleteTool(host, taskId),
    taskFailTool(host, taskId),
    taskAskTool(host, taskId),
    taskQueryTool(host, identity),
    ...host.tools,
  ];
}
