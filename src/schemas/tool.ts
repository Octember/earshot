import { z } from "zod";
import type { ToolFactory, ToolsetContext } from "../turn-runner/toolset-types";
import type { ActionClass } from "../policy/broker";

export type ToolResult = { success: boolean; output: string };

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
    const message = parsed.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
      .join("; ");
    return { success: false, output: message || "invalid arguments" };
  }
  return { ok: true, data: parsed.data };
}

export function defineTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>, ctx: ToolsetContext) => Promise<ToolResult> | ToolResult,
  inputSchema?: Record<string, unknown>,
): (ctx: ToolsetContext) => ToolFactory {
  return (ctx) => ({
    spec: {
      name,
      description,
      inputSchema: inputSchema ?? zodInputSchema(schema),
    },
    impl: async (args) => {
      const parsed = parseToolArgs(schema, args);
      if ("success" in parsed) return parsed;
      return run(parsed.data, ctx);
    },
  });
}

export type SlackToolSpec = {
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: unknown) => Promise<ToolResult>;
  actionClasses?: () => ActionClass[];
};

export function defineSlackTool<S extends z.ZodType>(
  description: string,
  schema: S,
  run: (args: z.infer<S>) => Promise<ToolResult> | ToolResult,
  extras?: { actionClasses?: () => ActionClass[] },
): SlackToolSpec {
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
