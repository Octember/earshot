import { inject, injectAll, singleton } from "tsyringe";
import { eq } from "drizzle-orm";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { DB, LedgerService, type Db } from "./ledger-service";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { tasks, type Task } from "./ledger/schema";
import { TOOL } from "./tokens";
import { taskTools } from "./tools";
import { Workspaces } from "./workspaces";

@singleton()
export class Execution {
  constructor(
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
    private readonly codex: Codex,
    @injectAll(TOOL) private readonly tools: DynamicTool[],
    private readonly workspaces: Workspaces,
  ) {}

  async launch(taskId: string): Promise<boolean> {
    const task = this.task(taskId);
    if (task?.status !== "active") return false;
    try {
      await this.run(task);
    } catch (error) {
      log.error("execution threw", { taskId, error: String(error) });
      if (this.task(taskId)?.status === "active")
        this.ledger.interrupt(taskId, this.policy.executions.max_attempts);
    }
    const after = this.task(taskId);
    return after?.status === "done" || after?.waitingOn === "human";
  }

  private task(taskId: string): Task | undefined {
    return this.db.query.tasks.findFirst({ where: eq(tasks.id, taskId) }).sync();
  }

  private async run({ id: taskId, tier }: Task): Promise<void> {
    const { executions } = this.policy;
    const cwd = this.workspaces.home;
    const session = this.codex.worker([...taskTools(taskId), ...this.tools], tier);
    await session.start(cwd);
    const threadId = await session.startThread(cwd);
    let turn = 1;
    try {
      for (; ; turn++) {
        const task = this.task(taskId);
        if (task?.status !== "active") break;
        if (turn > executions.max_turns) {
          this.ledger.transition(taskId, {
            type: "wait",
            waitingOn: "timer",
            wakeAt: new Date(Date.now() + executions.backoff_ms).toISOString(),
          });
          break;
        }
        await session.runTurn(threadId, cwd, task.spec, taskId);
      }
    } finally {
      session.stop();
    }
    const after = this.task(taskId);
    log.info("execution finished", {
      taskId,
      status: after?.status,
      outcome: after?.outcome,
      turns: turn - 1,
      tier,
    });
  }
}
