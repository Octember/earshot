import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { InjectionToken } from "tsyringe";

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

export const TOOL: InjectionToken<DynamicTool> = Symbol("tool");
export const BOT_USER_ID: InjectionToken<string> = Symbol("botUserId");
export const WORKSPACE: InjectionToken<string> = Symbol("workspace");
