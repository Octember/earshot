import type { ToolSpec } from "../policy/broker";

export interface ToolExample {
  when: string;
  tool: string;
  args: unknown;
  result?: string;
}

export interface ToolGroup {
  name: string;
  skill?: string;
  examples?: ToolExample[];
  tools: string[];
}

export interface ToolRegistry {
  name: string;
  skill?: string;
  examples?: ToolExample[];
  tools: Record<string, ToolSpec>;
}
