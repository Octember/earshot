import { inject, injectAll, singleton } from "tsyringe";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { Ledger } from "./ledger";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import type { Task } from "./ledger/schema";
import { TOOL } from "./tokens";
import { taskAskTool, taskCompleteTool, taskQueryTool } from "./tools-tasks";
import { setWakeTool } from "./tools-presence";
import { Workspaces } from "./workspaces";

@singleton()
export class Execution {
  constructor(
    private readonly ledger: Ledger,
    @inject(POLICY) private readonly policy: Policy,
    private readonly codex: Codex,
    @injectAll(TOOL) private readonly tools: DynamicTool[],
    private readonly workspaces: Workspaces,
  ) {}

  /** True when the task settled (done, or waiting on a human): she should hear about it. */
  async launch(taskId: string): Promise<boolean> {
    const task = this.ledger.task(taskId);
    if (!task || task.status !== "active") return false;
    try {
      await this.run(task);
    } catch (error) {
      log.error("execution threw", { taskId, error: String(error) });
      if (this.ledger.task(taskId)?.status === "active")
        this.ledger.interrupt(taskId, this.policy.executions.max_attempts);
    }
    const after = this.ledger.task(taskId);
    return after !== null && (after.status === "done" || after.waitingOn === "human");
  }

  private async run({ id: taskId, tier }: Task): Promise<void> {
    const { executions } = this.policy;
    const cwd = this.workspaces.home;
    const session = this.codex.worker(
      [
        setWakeTool(this.ledger, taskId),
        taskCompleteTool(this.ledger, taskId),
        taskAskTool(this.ledger, this.policy, taskId),
        taskQueryTool(this.ledger),
        ...this.tools,
      ],
      tier,
    );
    await session.start(cwd);
    const threadId = await session.startThread(cwd);
    let turn = 1;
    try {
      for (; this.ledger.task(taskId)?.status === "active"; turn++) {
        if (turn > executions.max_turns) {
          this.ledger.transition(taskId, {
            type: "wait",
            waitingOn: "timer",
            wakeAt: new Date(Date.now() + executions.backoff_ms).toISOString(),
          });
          break;
        }
        const spec = this.ledger.task(taskId)?.spec ?? "";
        await session.runTurn(threadId, cwd, spec, `${taskId}: turn ${turn}`);
      }
    } finally {
      session.stop();
    }
    const after = this.ledger.task(taskId);
    log.info("execution finished", {
      taskId,
      status: after?.status,
      outcome: after?.outcome,
      turns: turn - 1,
      tier,
    });
  }
}
