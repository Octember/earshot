import type { AgentRuntimeSession, DynamicTool } from "../../src/turn-runner/types";

// A scripted stand-in for AgentRuntimeSession (real: AppServerSession driving actual codex) so
// turn-contract tests never spawn a real subprocess. `script` simulates "what the model does this
// turn" by calling into the same DynamicTool objects the real session would dispatch tool calls
// to; it also gets a `markActivity` callback so a test can simulate an active-but-slow turn
// without tripping the stall watchdog (SPEC §6.3).
export type TurnScript = (turnNumber: number, tools: Map<string, DynamicTool>, markActivity: () => void) => Promise<void>;

export class FakeAgentRuntimeSession implements AgentRuntimeSession {
  turnNumber = 0;
  stopped = false;
  private tools: Map<string, DynamicTool>;
  private lastActivityAt = Date.now();

  constructor(
    tools: DynamicTool[],
    private script: TurnScript,
  ) {
    this.tools = new Map(tools.map((t) => [t.spec.name, t]));
  }

  async start(): Promise<void> {}

  async startThread(): Promise<string> {
    return "thread-1";
  }

  async resumeThread(threadId: string): Promise<string> {
    return threadId;
  }

  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  msSinceLastActivity(now = Date.now()): number {
    return now - this.lastActivityAt;
  }

  async runTurn(): Promise<void> {
    this.turnNumber++;
    this.markActivity();
    if (this.stopped) throw new Error("session stopped");
    await this.script(this.turnNumber, this.tools, () => this.markActivity());
  }

  stop(): void {
    this.stopped = true;
  }
}
