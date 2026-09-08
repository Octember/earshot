import {
  AppServerSession,
  maybeRotateGateway,
  scrubSecrets,
  type CodexConfig,
  type DynamicTool,
} from "@bevyl-ai/agent-tools";
import { inject, injectAll, singleton } from "tsyringe";
import { log } from "./log";
import type { Task } from "./ledger/schema";
import { POLICY, type Policy } from "./policy";
import { LedgerService } from "./ledger-service";
import { Soul } from "./soul";
import { Workspaces, type Role } from "./workspaces";
import { TOOL } from "./tokens";
import { taskTools, verdictTool } from "./tools";

const SPEAKING = new Set(["reply", "react"]);

@singleton()
export class Codex {
  constructor(
    @inject(POLICY) private readonly policy: Policy,
    private readonly soul: Soul,
    private readonly ledger: LedgerService,
    private readonly workspaces: Workspaces,
    @injectAll(TOOL) private readonly tools: DynamicTool[],
  ) {}

  respond(prompt: string): Promise<void> {
    const { turns } = this.policy;
    return this.session("resident", this.tools, {
      turnTimeoutMs: turns.interactive_timeout_ms,
      stallTimeoutMs: turns.stall_timeout_ms,
    }).runOnce(prompt);
  }

  async shouldAgentRespond(prompt: string): Promise<boolean> {
    const { turns, models } = this.policy;
    await this.session("ear", [verdictTool()], {
      ...models.low,
      turnTimeoutMs: turns.interactive_timeout_ms,
      stallTimeoutMs: turns.stall_timeout_ms,
    }).runOnce(prompt);
    return this.ledger.wantsResponse();
  }

  runWorker(taskId: string, tier: Task["tier"], next: () => string | null): Promise<void> {
    const { executions, models } = this.policy;
    const voiceless = this.tools.filter((t) => !SPEAKING.has(t.name));
    return this.session(
      "worker",
      [...taskTools(taskId), ...voiceless],
      { ...models[tier], stallTimeoutMs: executions.stall_timeout_ms, title: taskId },
      () => {
        this.ledger.interrupt(taskId);
      },
    ).runTurns(next);
  }

  private session(
    role: Role,
    tools: DynamicTool[],
    config: Partial<CodexConfig>,
    onTurnError: () => void = () => {},
  ): AppServerSession {
    this.soul.refresh();
    return new AppServerSession(
      { cwd: this.workspaces[role], title: role, ...config },
      tools,
      (event) => {
        if (event.log) log.info(role, { line: event.log });
      },
      {
        scrubEnv: scrubSecrets,
        onTurnError: (error) => {
          maybeRotateGateway({ reason: String(error) });
          onTurnError();
        },
      },
    );
  }
}
