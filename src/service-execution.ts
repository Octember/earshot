import { interrupt } from "./ledger/scheduler";
import { getTask } from "./ledger/tasks-query";
import { transition } from "./ledger/tasks-transition";
import { log } from "./log";
import { codexSession } from "./main-codex";
import { taskAskTool, taskCompleteTool, taskFailTool, taskQueryTool } from "./tools-tasks";
import { setWakeTool } from "./tools-presence";
import type { Service } from "./service";
import { refreshSoul } from "./soul";

export function launchExecution(host: Service, taskId: string): void {
  const task = getTask(host.db, taskId);
  if (!task || task.status !== "active") return;
  const identity = host.identityById(task.identityId);
  if (!identity) return;
  const { executions } = host.policy;
  refreshSoul(host);

  const run = async (): Promise<void> => {
    const cwd = host.workspaceFor(identity.id);
    const session = codexSession(
      [
        setWakeTool(host, taskId),
        taskCompleteTool(host, taskId),
        taskFailTool(host, taskId),
        taskAskTool(host, taskId),
        taskQueryTool(host, identity),
        ...host.tools,
      ],
      undefined,
      { ...host.policy.models[task.tier], stallTimeoutMs: executions.stall_timeout_ms },
    );
    await session.start(cwd);
    const threadId = await session.startThread(cwd);
    let turnsRun = 0;
    try {
      for (let turn = 1; getTask(host.db, taskId)?.status === "active"; turn++) {
        if (turn > executions.max_turns) {
          transition(host.db, taskId, {
            type: "wait",
            waitingOn: "timer",
            wakeAt: new Date(Date.now() + executions.backoff_ms).toISOString(),
          });
          break;
        }
        turnsRun++;
        const spec = getTask(host.db, taskId)?.spec ?? "";
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
          if (getTask(host.db, taskId)?.status === "active")
            interrupt(host.db, taskId, executions.max_attempts);
          break;
        }
      }
    } finally {
      session.stop();
    }
    const after = getTask(host.db, taskId);
    log.info("execution finished", {
      taskId,
      status: after?.status,
      outcome: after?.outcome,
      turnsRun,
      tier: task.tier,
    });
  };

  host.track(
    run()
      .catch((error: unknown) => {
        log.error("execution threw", { taskId, error: String(error) });
        if (getTask(host.db, taskId)?.status === "active")
          interrupt(host.db, taskId, executions.max_attempts);
      })
      .finally(() => {
        const after = getTask(host.db, taskId);
        if (after && (after.status === "done" || after.waitingOn === "human"))
          host.resident.schedule(task.identityId, 0);
        host.tick();
      }),
  );
}
