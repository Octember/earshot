import { codexThread, maybeRotateGateway, type Tools } from "@bevyl-ai/agent-tools";
import { inject, singleton } from "tsyringe";
import { LedgerService } from "./ledger-service";
import type { Task } from "./ledger/schema";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { Soul } from "./soul";
import { earTools, residentTools, workerTools } from "./tools";
import { Workspaces, type Role } from "./workspaces";

type Tier = Policy["models"]["low"];
type Thread = Awaited<ReturnType<typeof codexThread>>["thread"];

@singleton()
export class Codex {
  constructor(
    @inject(POLICY) private readonly policy: Policy,
    private readonly soul: Soul,
    private readonly ledger: LedgerService,
    private readonly workspaces: Workspaces,
  ) {}

  respond(prompt: string): Promise<void> {
    return this.once("resident", residentTools, {}, this.policy.turns.timeout_ms, prompt);
  }

  async shouldAgentRespond(prompt: string): Promise<boolean> {
    await this.once("ear", earTools, this.policy.models.low, this.policy.turns.timeout_ms, prompt);
    return this.ledger.wantsResponse();
  }

  async runWorker(taskId: string, tier: Task["tier"], next: () => string | null): Promise<void> {
    const { executions, models } = this.policy;
    const { thread, close } = await this.thread("worker", workerTools(taskId), models[tier]);
    try {
      for (let prompt = next(); prompt !== null; prompt = next())
        await this.turn(thread, taskId, prompt, executions.turn_timeout_ms).catch(
          (error: unknown) => {
            this.ledger.interrupt(taskId);
            throw error;
          },
        );
    } finally {
      close();
    }
  }

  private async once(role: Role, tools: Tools, tier: Tier, timeoutMs: number, prompt: string) {
    const { thread, close } = await this.thread(role, tools, tier);
    try {
      await this.turn(thread, role, prompt, timeoutMs);
    } finally {
      close();
    }
  }

  private thread(role: Role, tools: Tools, tier: Tier) {
    this.soul.refresh();
    return codexThread({
      tools,
      workingDirectory: this.workspaces[role],
      sandboxMode: "danger-full-access",
      networkAccessEnabled: true,
      ...(tier.model ? { model: tier.model } : {}),
      ...(tier.effort ? { modelReasoningEffort: tier.effort } : {}),
    });
  }

  private async turn(thread: Thread, label: string, prompt: string, timeoutMs: number) {
    const { events } = await thread.runStreamed(prompt, { signal: AbortSignal.timeout(timeoutMs) });
    for await (const event of events) {
      if (event.type === "item.completed") {
        const { item } = event;
        if (item.type === "command_execution") log.info(label, { line: `$ ${item.command}` });
        else if (item.type === "mcp_tool_call")
          log.info(label, { line: `⚙ ${item.tool} ${JSON.stringify(item.arguments)}` });
        else if (item.type === "agent_message") log.info(label, { line: `● ${item.text}` });
      } else if (event.type === "turn.failed") {
        maybeRotateGateway({ reason: event.error.message });
        throw new Error(event.error.message);
      } else if (event.type === "error") throw new Error(event.message);
    }
  }
}
