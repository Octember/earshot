import { inject, singleton } from "tsyringe";
import { eq } from "drizzle-orm";
import { Codex } from "./codex";
import { DB, LedgerService, type Db } from "./ledger-service";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { tasks, type Task } from "./ledger/schema";
import { Workspaces } from "./workspaces";

@singleton()
export class Execution {
  constructor(
    @inject(DB) private readonly db: Db,
    private readonly ledger: LedgerService,
    @inject(POLICY) private readonly policy: Policy,
    private readonly codex: Codex,
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
    const session = this.codex.worker(taskId, tier);
    await session.start(cwd);
    const threadId = await session.startThread(cwd);
    let turns = 0;
    try {
      for (
        let task = this.task(taskId);
        task?.status === "active" && turns < executions.max_turns;
        task = this.task(taskId)
      ) {
        turns++;
        await session.runTurn(threadId, cwd, task.spec, taskId);
      }
    } finally {
      session.stop();
    }
    if (this.task(taskId)?.status === "active")
      this.ledger.transition(taskId, {
        type: "wait",
        waitingOn: "timer",
        wakeAt: new Date(Date.now() + executions.backoff_ms).toISOString(),
      });
    const after = this.task(taskId);
    log.info("execution finished", {
      taskId,
      status: after?.status,
      outcome: after?.outcome,
      turns,
      tier,
    });
  }
}
