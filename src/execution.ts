import { inject, injectAll, singleton } from "tsyringe";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { LEDGER, type Ledger } from "./ledger/db";
import { interrupt } from "./ledger/scheduler";
import { getTask } from "./ledger/tasks-query";
import { transition } from "./ledger/tasks-transition";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import type { Task } from "./ledger/schema";
import { Soul } from "./soul";
import { TOOL } from "./tokens";
import { taskAskTool, taskCompleteTool, taskQueryTool } from "./tools-tasks";
import { setWakeTool } from "./tools-presence";
import { Workspaces } from "./workspaces";

@singleton()
export class Execution {
  constructor(
    @inject(LEDGER) private readonly db: Ledger,
    @inject(POLICY) private readonly policy: Policy,
    private readonly codex: Codex,
    @injectAll(TOOL) private readonly tools: DynamicTool[],
    private readonly workspaces: Workspaces,
    private readonly soul: Soul,
  ) {}

  /** True when the task settled (done, or waiting on a human): she should hear about it. */
  async launch(taskId: string): Promise<boolean> {
    const task = getTask(this.db, taskId);
    if (!task || task.status !== "active") return false;
    this.soul.refresh();
    try {
      await this.run(task);
    } catch (error) {
      log.error("execution threw", { taskId, error: String(error) });
      if (getTask(this.db, taskId)?.status === "active")
        interrupt(this.db, taskId, this.policy.executions.max_attempts);
    }
    const after = getTask(this.db, taskId);
    return after !== null && (after.status === "done" || after.waitingOn === "human");
  }

  private async run({ id: taskId, tier }: Task): Promise<void> {
    const { executions } = this.policy;
    const cwd = this.workspaces.home;
    const session = this.codex.worker(
      [
        setWakeTool(this.db, taskId),
        taskCompleteTool(this.db, taskId),
        taskAskTool(this.db, this.policy, taskId),
        taskQueryTool(this.db),
        ...this.tools,
      ],
      tier,
    );
    await session.start(cwd);
    const threadId = await session.startThread(cwd);
    let turnsRun = 0;
    try {
      for (let turn = 1; getTask(this.db, taskId)?.status === "active"; turn++) {
        if (turn > executions.max_turns) {
          transition(this.db, taskId, {
            type: "wait",
            waitingOn: "timer",
            wakeAt: new Date(Date.now() + executions.backoff_ms).toISOString(),
          });
          break;
        }
        turnsRun++;
        const spec = getTask(this.db, taskId)?.spec ?? "";
        await session.runTurn(
          threadId,
          cwd,
          turn === 1
            ? `Work this task to a terminal state. Nobody sees anything until you end with exactly one of task_complete, task_ask, or set_wake.\n\n${spec}`
            : `Continuation, turn ${turn}. ${spec}`,
          `${taskId}: turn ${turn}`,
        );
      }
    } finally {
      session.stop();
    }
    const after = getTask(this.db, taskId);
    log.info("execution finished", {
      taskId,
      status: after?.status,
      outcome: after?.outcome,
      turnsRun,
      tier,
    });
  }
}
