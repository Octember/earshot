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

// The narrow interface the execution loop and turn runner depend on — the kit's AppServerSession and the fake
// test double both implement this, so tests never spawn a real subprocess.
export interface AgentRuntimeSession {
  start(cwd: string): Promise<void>;
  startThread(cwd: string): Promise<string>;
  resumeThread(threadId: string): Promise<string>;
  // Positions 5/6 (sandbox, model) belong to the kit's wider signature; earshot never sets them.
  runTurn(threadId: string, cwd: string, prompt: string, title: string, sandbox?: unknown, model?: string | null, images?: string[]): Promise<void>;
  stop(): void;
  // Real wall-clock ms since the last JSON-RPC activity (message sent or received) — NOT the ledger's injectable
  // Clock, which is about task/turn timestamps, not process liveness. Used by the execution loop's stall watchdog
  // (SPEC §6.3's stall_timeout_ms: idle time, not total turn time). Optional so a minimal fake session can omit it
  // (treated as never stalled).
  msSinceLastActivity?(now?: number): number;
}
