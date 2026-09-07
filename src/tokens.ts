import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { InjectionToken } from "tsyringe";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export const RESIDENT_TOOL: InjectionToken<DynamicTool> = Symbol("residentTool");
export const WORKER_TOOL: InjectionToken<DynamicTool> = Symbol("workerTool");
export const BOT_USER_ID: InjectionToken<string> = Symbol("botUserId");
export const WORKSPACE: InjectionToken<string> = Symbol("workspace");
