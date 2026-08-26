import type { DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolSpec } from "../policy/broker";
import { isRecord } from "../guard";

export function asRecord(args: unknown): Record<string, unknown> {
  return isRecord(args) ? args : {};
}

export function topLevelMutationFields(query: string): string[] {
  const fields: string[] = [];
  const clean = query.replaceAll(/"(?:[^"\\]|\\.)*"/g, '""').replaceAll(/#[^\n]*/g, "");
  const opRe = /\bmutation\b[^{]*\{/g;
  let opMatch: RegExpExecArray | null;
  while ((opMatch = opRe.exec(clean))) {
    let depth = 1;
    let index = opRe.lastIndex;
    let buf = "";
    while (index < clean.length && depth > 0) {
      const char = clean[index]!;
      if (char === "{") {
        depth++;
        buf = "";
      } else if (char === "}") {
        depth--;
        buf = "";
      } else if (depth === 1) {
        if (char === "(") {
          const match = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(
            buf,
          );
          if (match) fields.push(match[2]!);
          let parenDepth = 1;
          while (index + 1 < clean.length && parenDepth > 0) {
            index++;
            if (clean[index] === "(") parenDepth++;
            else if (clean[index] === ")") parenDepth--;
          }
          buf = "";
        } else {
          buf += char;
        }
      }
      if (char === "{" && depth === 2) {
        const match = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*$/.exec(
          clean.slice(opMatch.index, index).split("{").pop() ?? "",
        );
        if (match && match[2] && !fields.includes(match[2])) fields.push(match[2]);
      }
      index++;
    }
    opRe.lastIndex = index;
  }
  return [...new Set(fields)];
}

export function grain(
  tool: DynamicTool,
  opts: {
    description: string;
    write: boolean;
    wrongGrain: (args: unknown) => boolean;
    rejection: string;
    scopeCheck?: ToolSpec["scopeCheck"];
  },
): ToolSpec {
  return {
    description: opts.description,
    inputSchema: tool.spec.inputSchema,
    actionClasses: opts.write ? () => ["outward"] : () => [],
    ...(opts.scopeCheck ? { scopeCheck: opts.scopeCheck } : {}),
    run: async (args) =>
      opts.wrongGrain(args) ? { success: false, output: opts.rejection } : tool.run(args),
  };
}

export function fromKitReadOnly(tool: DynamicTool): ToolSpec {
  return {
    description: tool.spec.description,
    inputSchema: tool.spec.inputSchema,
    actionClasses: () => [],
    run: (args) => tool.run(args),
  };
}

export function readWritePair(opts: {
  kit: DynamicTool;
  readName: string;
  writeName: string;
  readDescription: string;
  writeDescription: string;
  isWrite: (args: unknown) => boolean;
  readRejection: string;
  writeRejection: string;
  scopeCheck?: ToolSpec["scopeCheck"];
}): Record<string, ToolSpec> {
  return {
    [opts.readName]: grain(opts.kit, {
      description: opts.readDescription,
      write: false,
      wrongGrain: opts.isWrite,
      rejection: opts.readRejection,
    }),
    [opts.writeName]: grain(opts.kit, {
      description: opts.writeDescription,
      write: true,
      wrongGrain: (args) => !opts.isWrite(args),
      rejection: opts.writeRejection,
      ...(opts.scopeCheck ? { scopeCheck: opts.scopeCheck } : {}),
    }),
  };
}
