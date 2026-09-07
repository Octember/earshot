import {
  AppServerSession,
  maybeRotateGateway,
  scrubSecrets,
  type CodexConfig,
  type DynamicTool,
} from "@bevyl-ai/agent-tools";
import { inject, singleton } from "tsyringe";
import { log } from "./log";
import type { Task } from "./ledger/schema";
import { POLICY, type Policy } from "./policy";
import { Soul } from "./soul";

const SPEAKING = new Set(["reply", "react"]);

@singleton()
export class Codex {
  constructor(
    @inject(POLICY) private readonly policy: Policy,
    private readonly soul: Soul,
  ) {}

  resident(tools: DynamicTool[]): AppServerSession {
    const { turns } = this.policy;
    return this.session("resident", tools, {
      turnTimeoutMs: turns.interactive_timeout_ms,
      stallTimeoutMs: turns.stall_timeout_ms,
    });
  }

  ear(tools: DynamicTool[]): AppServerSession {
    const { turns, models } = this.policy;
    return this.session("ear", tools, {
      ...models.low,
      turnTimeoutMs: turns.interactive_timeout_ms,
      stallTimeoutMs: turns.stall_timeout_ms,
    });
  }

  worker(tools: DynamicTool[], tier: Task["tier"]): AppServerSession {
    const { executions, models } = this.policy;
    const voiceless = tools.filter((t) => !SPEAKING.has(t.name));
    return this.session("worker", voiceless, {
      ...models[tier],
      stallTimeoutMs: executions.stall_timeout_ms,
    });
  }

  private session(
    label: string,
    tools: DynamicTool[],
    config: Partial<CodexConfig>,
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
          maybeRotateGateway({ reason: error instanceof Error ? error.message : String(error) });
        },
      },
    );
  }
}
