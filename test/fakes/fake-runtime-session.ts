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

  // Records how this session got its thread — lets a test prove thread identity (a resident
  // wake STARTS a fresh thread every time; an execution resumes its persisted id).
  lastThreadOp: { op: "start" | "resume"; id: string } | null = null;
  static threadsMinted = 0;

  // Which kind of session a test harness handed a script: the ear's has `verdict`, the mind's
  // has `reply`, an execution's has outcome tools.
  hasTool(name: string): boolean {
    return this.tools.has(name);
  }

  async start(): Promise<void> {}

  async startThread(): Promise<string> {
    const id = `thread-${++FakeAgentRuntimeSession.threadsMinted}`;
    this.lastThreadOp = { op: "start", id };
    return id;
  }

  async resumeThread(threadId: string): Promise<string> {
    this.lastThreadOp = { op: "resume", id: threadId };
    return threadId;
  }

  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  msSinceLastActivity(now = Date.now()): number {
    return now - this.lastActivityAt;
  }

  // Prompts received, in order — lets tests assert what context a turn opened with.
  prompts: string[] = [];
  // Image paths received per turn (vision input), parallel to prompts.
  images: string[][] = [];

  async runTurn(_threadId?: string, _cwd?: string, prompt?: string, _title?: string, _sandbox?: unknown, _model?: string | null, images?: string[]): Promise<void> {
    this.turnNumber++;
    this.prompts.push(prompt ?? "");
    this.images.push(images ?? []);
    this.markActivity();
    if (this.stopped) throw new Error("session stopped");
    await this.script(this.turnNumber, this.tools, () => this.markActivity());
  }

  stop(): void {
    this.stopped = true;
  }
}
