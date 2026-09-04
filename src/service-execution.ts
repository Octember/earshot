import { interrupt } from "./ledger/scheduler";
import { getTask } from "./ledger/tasks-query";
import { transition } from "./ledger/tasks-transition";
import { executionToolset } from "./turn-runner/toolset";
import { runTurn } from "./turn-runner/turn";
import type { Service } from "./service";
import { refreshSoul } from "./service-soul";

export function launchExecution(host: Service, taskId: string): void {
  const task = getTask(host.db, taskId);
  if (!task || task.status !== "active") return;
  const identity = host.identityById(task.identityId);
  if (!identity) return;
  const { executions } = host.policy;
  refreshSoul(host);

  const run = async (): Promise<void> => {
    const cwd = host.workspaceFor(identity.id);
    const tools = executionToolset({ host, identity, taskId });
    const session = host.sessionFactory(tools, undefined, host.policy.models[task.tier]);
    await session.start(cwd);
    const threadId = await session.startThread(cwd);
    let turnsRun = 0;
    try {
      for (let turn = 1; getTask(host.db, taskId)?.status === "active"; turn++) {
        if (turn > executions.max_turns) {
          transition(host.db, host.clock, taskId, {
            type: "wait",
            waitingOn: "timer",
            wakeAt: new Date(Date.parse(host.clock()) + executions.backoff_ms).toISOString(),
          });
          break;
        }
        turnsRun++;
        const spec = getTask(host.db, taskId)?.spec ?? "";
        const result = await runTurn({
          session,
          threadId,
          cwd,
          prompt:
            turn === 1
              ? `You are working ONE delegated task to a terminal state, as a background worker. Nothing you write is seen by anyone until you hand it back: end every run with exactly one outcome tool. task_complete when done, task_fail if it can't be done, task_ask if blocked on a human, or set_wake to check back later (a routine nothing-new check ends with set_wake alone). Your report goes to the main mind, who speaks to the room: write it as a complete handoff with receipts (links, ids, what changed), not a status diary.\n\n${spec}`
              : `Continuation, turn ${turn}. ${spec}`,
          title: `${taskId}: turn ${turn}`,
          stallTimeoutMs: executions.stall_timeout_ms,
        });
        if (result.status === "failed" && getTask(host.db, taskId)?.status === "active") {
          interrupt(host.db, host.clock, taskId, executions.max_attempts);
          break;
        }
      }
    } finally {
      session.stop();
    }
    const after = getTask(host.db, taskId);
    host.log.info("execution finished", {
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
        host.log.error("execution threw", { taskId, error: String(error) });
        if (getTask(host.db, taskId)?.status === "active")
          interrupt(host.db, host.clock, taskId, executions.max_attempts);
      })
      .finally(() => {
        const after = getTask(host.db, taskId);
        if (after && (after.status === "done" || after.waitingOn === "human"))
          host.resident.schedule(task.identityId, 0);
        host.maybeTick();
      }),
  );
}
