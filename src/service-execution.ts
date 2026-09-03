import { interrupt } from "./ledger/scheduler";
import { getTask } from "./ledger/tasks-query";
import { runExecution } from "./turn-runner/execution-loop";
import { buildToolbox, renderToolbox } from "./tools/catalog";
import type { Service } from "./service";
import { scheduleWake } from "./service-wake";
import { refreshSoul } from "./service-soul";

export function launchExecution(ctx: Service, taskId: string): void {
  const task = getTask(ctx.d.db, taskId);
  if (!task || task.status !== "active") return;
  const identity = ctx.identityById(task.identityId);
  if (!identity) return;
  const policy = ctx.policy();

  refreshSoul(ctx);
  const promise = runExecution({
    db: ctx.d.db,
    clock: ctx.d.clock,
    taskId,
    identity,
    catalog: ctx.catalog,
    cwd: ctx.workspaceFor(identity.id),
    parkAfterMs: policy.tasks.parkAfterMs,
    permalink: (venueId: string, ts: string) => ctx.d.adapter.permalink(venueId, ts),
    maxTurns: policy.executions.maxTurns,
    maxTurnsBackoffMs: policy.executions.backoffMs,
    maxInterruptions: policy.executions.maxAttempts,
    stallTimeoutMs: policy.executions.stallTimeoutMs,
    postMessage: async (anchor, text) => {
      ctx.log.warn("worker attempted to post — dropped (workers report to the mind)", {
        taskId,
        venueId: anchor.venueId,
        chars: text.length,
      });
      return { messageId: "worker-no-post" };
    },
    buildPrompt: (turnNumber, tools) => {
      const spec = getTask(ctx.d.db, taskId)?.spec ?? "";
      return turnNumber === 1
        ? `${renderToolbox(buildToolbox(tools, ctx.registries))}\n\nYou are working ONE delegated task to a terminal state, as a background worker. Nothing you write is seen by anyone until you hand it back: end every run with exactly one outcome tool. task_complete when done, task_fail if it can't be done, task_ask if blocked on a human, or set_wake to check back later (a routine nothing-new check ends with set_wake alone). Your report goes to the main mind, who speaks to the room: write it as a complete handoff with receipts (links, ids, what changed), not a status diary.\n\n${spec}`
        : `Continuation, turn ${turnNumber}. ${spec}`;
    },
    newTurnId: () => ctx.d.newId(),
    sessionFactory: (tools) => ctx.d.sessionFactory(tools, undefined, policy.models[task.tier]),
  })
    .then((result) => {
      ctx.log.info("execution finished", {
        taskId,
        status: result.task.status,
        outcome: result.task.outcome,
        turnsRun: result.turnsRun,
        tier: task.tier,
      });
      return result;
    })
    .catch((error: unknown) => {
      ctx.log.error("execution threw", { taskId, error: String(error) });
      if (getTask(ctx.d.db, taskId)?.status === "active")
        interrupt(ctx.d.db, ctx.d.clock, taskId, policy.executions.maxAttempts);
    })
    .finally(() => {
      const after = getTask(ctx.d.db, taskId);
      if (after && (after.status === "done" || after.waitingOn === "human"))
        scheduleWake(ctx, task.identityId, 0);
      ctx.maybeTick();
    });

  ctx.track(ctx.executions, promise);
}
