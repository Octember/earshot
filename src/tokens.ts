import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { InjectionToken } from "tsyringe";

export const TOOL: InjectionToken<DynamicTool> = Symbol("tool");
export const BOT_TOKEN: InjectionToken<string> = Symbol("botToken");
export const BOT_USER_ID: InjectionToken<string> = Symbol("botUserId");
export const WORKSPACE: InjectionToken<string> = Symbol("workspace");
