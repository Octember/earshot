// Turn-runner types: re-exports from @bevyl-ai/agent-tools plus earshot-local session/config seams.
export { CategorizedError } from "@bevyl-ai/agent-tools";
export type { DynamicTool, AgentEvent } from "@bevyl-ai/agent-tools";
import type { CodexConfig } from "@bevyl-ai/agent-tools";
export type { CodexConfig };

export interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export const DEFAULT_CODEX_CONFIG: CodexConfig = {
  command: "codex app-server",
  approvalPolicy: "never",
  threadSandbox: "workspace-write",
  turnSandboxPolicy: null,
  turnTimeoutMs: 10 * 60 * 1000,
  readTimeoutMs: 30_000,
  initTimeoutMs: 60_000,
  stallTimeoutMs: 5 * 60 * 1000,
};

// Session interface for turn runner (real AppServerSession or test fake).
export interface AgentRuntimeSession {
  start(cwd: string): Promise<void>;
  startThread(cwd: string): Promise<string>;
  resumeThread(threadId: string): Promise<string>;
  // Positions 5/6 (sandbox, model) belong to the kit's wider signature; earshot never sets them.
  runTurn(threadId: string, cwd: string, prompt: string, title: string, sandbox?: unknown, model?: string | null, images?: string[]): Promise<void>;
  stop(): void;
  // Wall-clock ms since last JSON-RPC activity (stall watchdog). Optional on fakes.
  msSinceLastActivity?(now?: number): number;
}
