// SPEC §11 — shared types for the turn runner / codex app-server integration.

export interface DynamicToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DynamicTool {
  spec: DynamicToolSpec;
  run(args: unknown): Promise<{ success: boolean; output: string }>;
}

export interface CodexConfig {
  command: string; // default "codex app-server"
  approvalPolicy: string; // "never" — turns run unattended
  threadSandbox: string;
  turnSandboxPolicy: Record<string, unknown> | null;
  turnTimeoutMs: number; // hard cap on one turn's total duration
  readTimeoutMs: number; // steady-state JSON-RPC request timeout
  initTimeoutMs: number; // generous timeout for the cold-boot handshake
  stallTimeoutMs: number; // SPEC §6.3: wall-clock with NO activity (not total turn time)
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

export interface AgentEvent {
  event?: string;
  ts?: string;
  log?: string;
  turnId?: string;
  threadId?: string;
  tokens?: { total: number; input: number; output: number; cached: number; reasoning: number };
  label?: string;
  stream?: string;
}

export class CategorizedError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CategorizedError";
  }
}

// The narrow interface the execution loop and turn runner depend on — real codex
// (AppServerSession) and the fake test double both implement this, so tests never spawn a real
// subprocess.
export interface AgentRuntimeSession {
  start(cwd: string): Promise<void>;
  startThread(cwd: string): Promise<string>;
  resumeThread(threadId: string): Promise<string>;
  runTurn(threadId: string, cwd: string, prompt: string, title: string): Promise<void>;
  stop(): void;
  // Real wall-clock ms since the last JSON-RPC activity (message sent or received) — NOT the
  // ledger's injectable Clock, which is about task/turn timestamps, not process liveness. Used by
  // the execution loop's stall watchdog (SPEC §6.3's stall_timeout_ms: idle time, not total turn
  // time). Optional so a minimal fake session can omit it (treated as never stalled).
  msSinceLastActivity?(now?: number): number;
}
