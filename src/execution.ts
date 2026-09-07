import { inject, injectAll, singleton } from "tsyringe";
import type { DynamicTool } from "@bevyl-ai/agent-tools";
import { Codex } from "./codex";
import { LEDGER, type Ledger } from "./ledger/db";
import { interrupt } from "./ledger/scheduler";
import { getTask } from "./ledger/tasks-query";
import { transition } from "./ledger/tasks-transition";
import { log } from "./log";
import { POLICY, type Policy } from "./policy";
import { Soul } from "./soul";
import { TOOL } from "./tokens";
import { taskAskTool, taskCompleteTool, taskFailTool, taskQueryTool } from "./tools-tasks";
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

  /** Returns the identity to wake when the task settled (done, or waiting on a human). */
  async launch(taskId: string): Promise<string | null> {
    const task = getTask(this.db, taskId);
    if (!task || task.status !== "active") return null;
    const identity = this.policy.identities.find((i) => i.id === task.identityId);
    if (!identity) return null;
    const { executions } = this.policy;
    this.soul.refresh();
    try {
      await this.run(taskId, identity.id, task.tier);
    } catch (error) {
      log.error("execution threw", { taskId, error: String(error) });
      if (getTask(this.db, taskId)?.status === "active")
        interrupt(this.db, taskId, executions.max_attempts);
    }
    const after = getTask(this.db, taskId);
    return after && (after.status === "done" || after.waitingOn === "human")
      ? task.identityId
      : null;
  }

  private async run(taskId: string, identityId: string, tier: "low" | "medium" | "high") {
    const { executions } = this.policy;
    const identity = this.policy.identities.find((i) => i.id === identityId)!;
    const cwd = this.workspaces.for(identityId);
    const session = this.codex.worker(
      [
        setWakeTool(this.db, taskId),
        taskCompleteTool(this.db, taskId),
        taskFailTool(this.db, taskId),
        taskAskTool(this.db, this.policy, taskId),
        taskQueryTool(this.db, identity),
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
        try {
          await session.runTurn(
            threadId,
            cwd,
            turn === 1
              ? `Work this task to a terminal state. Nobody sees anything until you end with exactly one of task_complete, task_fail, task_ask, or set_wake.\n\n${spec}`
              : `Continuation, turn ${turn}. ${spec}`,
            `${taskId}: turn ${turn}`,
          );
        } catch (error) {
          log.warn("execution turn failed", { taskId, turn, error: String(error) });
          if (getTask(this.db, taskId)?.status === "active")
            interrupt(this.db, taskId, executions.max_attempts);
          break;
        }
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
