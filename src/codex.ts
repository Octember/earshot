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
import { TOOL } from "./tokens";
import { taskTools, verdictTool } from "./tools";

const SPEAKING = new Set(["reply", "react"]);

@singleton()
export class Codex {
  constructor(
    @inject(POLICY) private readonly policy: Policy,
    private readonly soul: Soul,
    private readonly ledger: LedgerService,
    @injectAll(TOOL) private readonly tools: DynamicTool[],
  ) {}

  resident(): AppServerSession {
    const { turns } = this.policy;
    return this.session("resident", this.tools, {
      turnTimeoutMs: turns.interactive_timeout_ms,
      stallTimeoutMs: turns.stall_timeout_ms,
    });
  }

  ear(): AppServerSession {
    const { turns, models } = this.policy;
    return this.session("ear", [verdictTool()], {
      ...models.low,
      turnTimeoutMs: turns.interactive_timeout_ms,
      stallTimeoutMs: turns.stall_timeout_ms,
    });
  }

  worker(taskId: string, tier: Task["tier"]): AppServerSession {
    const { executions, models } = this.policy;
    const voiceless = this.tools.filter((t) => !SPEAKING.has(t.name));
    return this.session(
      "worker",
      [...taskTools(taskId), ...voiceless],
      { ...models[tier], stallTimeoutMs: executions.stall_timeout_ms },
      () => {
        this.ledger.interrupt(taskId);
      },
    );
  }

  private session(
    label: string,
    tools: DynamicTool[],
    config: Partial<CodexConfig>,
    onTurnError: () => void = () => {},
  ): AppServerSession {
    this.soul.refresh();
    return new AppServerSession(
      config,
      tools,
      (event) => {
        if (event.log) log.info(label, { line: event.log });
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
