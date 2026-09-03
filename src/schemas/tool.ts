import { z } from "zod";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolsetContext } from "../turn-runner/toolset-types";
import type { ActionClass, ToolSpec } from "../policy/broker";

export type ToolResult = { success: boolean; output: string };

export function formatZodIssues(error: z.ZodError): string {
  return (
    error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") ||
    "invalid arguments"
  );
}

export function zodInputSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export function parseToolArgs<S extends z.ZodType>(
  schema: S,
  args: unknown,
): { ok: true; data: z.infer<S> } | ToolResult {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { success: false, output: formatZodIssues(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

export function defineTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>, ctx: ToolsetContext) => Promise<ToolResult> | ToolResult,
  inputSchema?: Record<string, unknown>,
): (ctx: ToolsetContext) => DynamicTool {
  return (ctx) => ({
    spec: {
      name,
      description,
      inputSchema: inputSchema ?? zodInputSchema(schema),
    },
    run: async (args) => {
      const parsed = parseToolArgs(schema, args);
      if ("success" in parsed) return parsed;
      return run(parsed.data, ctx);
    },
  });
}

export function defineSlackTool<S extends z.ZodType>(
  description: string,
  schema: S,
  run: (args: z.infer<S>) => Promise<ToolResult> | ToolResult,
  extras?: { actionClasses?: () => ActionClass[] },
): ToolSpec {
  return {
    description,
    inputSchema: zodInputSchema(schema),
    ...(extras?.actionClasses ? { actionClasses: extras.actionClasses } : {}),
    run: async (args) => {
      const parsed = parseToolArgs(schema, args);
      if ("success" in parsed) return parsed;
      return run(parsed.data);
    },
  };
}
