import { z } from "zod";
import type { DynamicTool } from "@bevyl-ai/agent-tools";

export type ToolResult = { success: boolean; output: string };

export function defineTool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  run: (args: z.infer<S>) => Promise<ToolResult> | ToolResult,
): DynamicTool {
  return {
    spec: { name, description, inputSchema: z.toJSONSchema(schema) },
    run: async (args) => {
      try {
        return await run(schema.parse(args ?? {}));
      } catch (error) {
        return {
          success: false,
          output:
            error instanceof z.ZodError
              ? z.prettifyError(error)
              : error instanceof Error
                ? error.message
                : String(error),
        };
      }
    },
  };
}
