import { pendingApprovalFor } from "./ledger/outward-calls";
import { desc, sql, like } from "drizzle-orm";
import { openDirectAsk } from "./ledger/conversations-acts";
import { getTask, liveExecutionId } from "./ledger/tasks-query";
import { lastAskQuestion } from "./ledger/turns";
import { orm } from "./ledger/db";
import { events } from "./ledger/schema";
import { runExecution, type ExecutionOutcome } from "./turn-runner/execution-loop";
import { buildToolbox, renderToolbox } from "./tools/catalog";
import type { Service } from "./service";
import { scheduleWake } from "./service-wake";
import { refreshSoul } from "./service-soul";

export function launchExecution(ctx: Service, taskId: string): void {
  const executionId = liveExecutionId(ctx.d.db, taskId);
  if (!executionId) {
    ctx.log.warn("dispatched task has no live execution row", { taskId });
    return;
  }
  const task = getTask(ctx.d.db, taskId);
  if (!task) return;
  const identity = ctx.identityById(task.identityId);
  if (!identity) return;

  const policy = ctx.policy();

  const ask = openDirectAsk(ctx.d.db, task.identityId, task.homeVenueId, task.homeThreadRootId);
  if (ask) {
    void ctx.d.adapter
      .setSessionStatus(task.homeVenueId, ask.threadTs, "processing")
      .catch(() => {});
  }
  refreshSoul(ctx);
  const promise = runExecution({
    db: ctx.d.db,
    clock: ctx.d.clock,
    taskId,
    executionId,
    identity,
    catalog: ctx.catalog,
    cwd: ctx.workspaceFor(identity.id),
    nudgeAfterMs: policy.tasks.nudgeAfterMs,
    permalink: (venueId: string, ts: string) => ctx.d.adapter.permalink(venueId, ts),
    maxTurns: policy.executions.maxTurns,
    maxTurnsBackoffMs: policy.executions.backoffMs,
    maxConsecutiveInterruptions: policy.executions.maxAttempts,
    stallTimeoutMs: policy.executions.stallTimeoutMs,
    postMessage: async (anchor, text) => {
      ctx.log.warn("worker attempted to post — dropped (workers report to the mind)", {
        taskId,
        venueId: anchor.venueId,
        chars: text.length,
      });
      return { messageId: "worker-no-post" };
    },
    buildPrompt: (turnNumber, guidance, tools) => {
      const spec = getTask(ctx.d.db, taskId)?.spec ?? "";
      const note = guidance.length > 0 ? `\n\nNew guidance:\n${guidance.join("\n")}` : "";
      return turnNumber === 1
        ? `${renderToolbox(buildToolbox(tools, ctx.registries))}\n\nYou are working ONE delegated task to a terminal state, as a background worker. Nothing you write is seen by anyone until you hand it back: end every run with exactly one outcome tool. task_complete when done, task_fail if it can't be done, task_ask if blocked on a human, or set_wake to check back later (a routine nothing-new check ends with set_wake alone). Your report goes to the main mind, who speaks to the room: write it as a complete handoff with receipts (links, ids, what changed), not a status diary.\n\n${spec}${note}`
        : `Continuation, turn ${turnNumber}. ${spec}${note}`;
    },
    newTurnId: () => ctx.d.newId(),
    sessionFactory: (tools) => ctx.d.sessionFactory(tools, undefined, policy.models[task.tier]),
  })
    .then((result) => {
      ctx.log.info("execution finished", {
        taskId,
        outcome: result.outcome,
        turnsRun: result.turnsRun,
        tier: task.tier,
      });
      deliverWorkerReport(ctx, taskId, result.outcome);
      return result;
    })
    .catch((error: unknown) => {
      ctx.log.error("execution threw", { taskId, error: String(error) });
      deliverWorkerReport(ctx, taskId, "failed");
    })
    .finally(() => {
      ctx.maybeTick();
    });

  ctx.track(ctx.executions, promise);
}

export function deliverWorkerReport(ctx: Service, taskId: string, outcome: ExecutionOutcome): void {
  const task = getTask(ctx.d.db, taskId);
  if (!task) return;
  if (outcome === "yielded" && task.waitingOn === "timer") return;
  if (outcome === "cancelled") return;
  const detail =
    task.status === "waiting" && pendingApprovalFor(ctx.d.db, taskId)
      ? `it needs a go-ahead: ${pendingApprovalFor(ctx.d.db, taskId)?.description ?? ""}`
      : task.status === "waiting"
        ? `it's blocked on a question for the room: ${lastAskQuestion(ctx.d.db, taskId) ?? "(see the worker's report)"}`
        : (task.terminalReport ?? "(no report)");
  const text = `[task update] "${task.title}" (the work from <#${task.homeVenueId}>${task.homeThreadRootId ? `, thread ${task.homeThreadRootId}` : ""}) ${
    outcome === "done"
      ? "finished"
      : outcome === "failed"
        ? "failed"
        : outcome === "parked"
          ? "was parked after repeated interruptions"
          : "is waiting on a human"
  }. Worker's handoff: ${detail}`;
  try {
    const prev = orm(ctx.d.db)
      .select({ text: sql<string | null>`json_extract(${events.payload}, '$.text')` })
      .from(events)
      .where(like(events.dedupKey, `worker:${taskId}:%`))
      .orderBy(desc(events.rowid))
      .limit(1)
      .get();
    orm(ctx.d.db)
      .insert(events)
      .values({
        id: ctx.d.newId(),
        dedupKey: `worker:${taskId}:${ctx.d.newId()}`,
        kind: "external_signal",
        identityId: task.identityId,
        venueId: task.homeVenueId,
        threadRootId: task.homeThreadRootId,
        principalId: null,
        payload: { text, ts: null },
        receivedAt: ctx.d.clock(),
      })
      .run();
    if (prev?.text !== text) scheduleWake(ctx, task.identityId, 0);
  } catch (error) {
    ctx.log.error("worker report delivery failed", { taskId, error: String(error) });
  }
}
