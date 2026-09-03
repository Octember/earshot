import { z } from "zod";
import type { DynamicTool } from "@bevyl-ai/agent-tools";

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
    return {
      success: false,
      output:
        parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ") || "invalid arguments",
    };
  }
  return { ok: true, data: parsed.data };
}

export function defineTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>) => Promise<ToolResult> | ToolResult,
): DynamicTool {
  return {
    spec: { name, description, inputSchema: zodInputSchema(schema) },
    run: async (args) => {
      const parsed = parseToolArgs(schema, args);
      if ("success" in parsed) return parsed;
      return run(parsed.data);
    },
  };
}
