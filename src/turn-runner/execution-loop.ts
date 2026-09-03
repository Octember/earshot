import type { TurnEffect } from "../schemas/effects";

import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { getTask } from "../ledger/tasks-query";
import { consumeSteering } from "../ledger/tasks-steer";
import { transition } from "../ledger/tasks-transition";
import { homeAnchor } from "../ledger/tasks-types";
import { interruptOrPark } from "../ledger/scheduler";
import { taskSpend, budgetStatus, type BudgetStatusPolicy } from "../policy/budget";
import { buildToolset } from "./toolset";
import type { ToolsetContext } from "./toolset-types";
import { runTurn } from "./turn";
import type { AppServerSession, DynamicTool } from "@bevyl-ai/agent-tools";
import type { ToolCatalog } from "../policy/broker";
import type { IdentityConfig } from "../policy/schema";
import type { Anchor } from "../ledger/tasks-types";

export type ExecutionOutcome = "done" | "failed" | "cancelled" | "yielded" | "parked";

export async function runExecution(params: {
  db: Database;
  clock: Clock;
  taskId: string;
  executionId: string;
  identity: IdentityConfig;
  catalog: ToolCatalog;
  cwd: string;
  nudgeAfterMs: number;
  maxTurns: number;

  maxTurnsBackoffMs: number;
  maxConsecutiveInterruptions: number;
  stallTimeoutMs: number;
  postMessage: (anchor: Anchor, text: string) => Promise<{ messageId: string }>;
  permalink?: ((venueId: string, messageId: string) => string | undefined) | undefined;
  buildPrompt: (turnNumber: number, guidance: string[], tools: DynamicTool[]) => string;
  newTurnId: () => string;
  sessionFactory: (tools: DynamicTool[]) => AppServerSession;
  tokensUsed?: (() => number) | undefined;
  spendAmount?: (() => number) | undefined;

  perTaskCap?: number | null | undefined;
  budgetPolicy?: BudgetStatusPolicy | undefined;
}): Promise<{
  outcome: ExecutionOutcome;
  turnsRun: number;
}> {
  const task = getTask(params.db, params.taskId);
  if (!task) throw new Error(`no such task: ${params.taskId}`);

  const effects: TurnEffect[] = [];
  const ctx: ToolsetContext = {
    db: params.db,
    clock: params.clock,
    identity: params.identity,
    turnKind: "execution_step",
    catalog: params.catalog,
    anchor: homeAnchor(task),
    taskId: params.taskId,
    nudgeAfterMs: params.nudgeAfterMs,
    postMessage: params.postMessage,
    permalink: params.permalink,
    effects,
  };
  const toolset = buildToolset(ctx);
  const session = params.sessionFactory(toolset);
  await session.start(params.cwd);
  const threadId = await session.startThread(params.cwd);

  const tokensUsed = params.tokensUsed ?? (() => 0);
  const spendAmount = params.spendAmount ?? (() => 0);

  let turnsRun = 0;
  try {
    for (let turnNum = 1; ; turnNum++) {
      const current = getTask(params.db, params.taskId);
      if (!current || current.status !== "active") break;

      const queued = consumeSteering(params.db, params.clock, params.taskId);
      const afterSteering = getTask(params.db, params.taskId);
      if (!afterSteering || afterSteering.status !== "active") break;

      if (turnNum > params.maxTurns) {
        const wakeAt = new Date(
          new Date(params.clock()).getTime() + params.maxTurnsBackoffMs,
        ).toISOString();
        transition(params.db, params.clock, params.taskId, {
          type: "yield_timer",
          wakeAt,
        });
        break;
      }

      if (params.perTaskCap != null && taskSpend(params.db, params.taskId) >= params.perTaskCap) {
        const nudgeDeadline = new Date(
          new Date(params.clock()).getTime() + params.nudgeAfterMs,
        ).toISOString();
        transition(params.db, params.clock, params.taskId, {
          type: "yield_human",
          nudgeDeadline,
        });
        break;
      }

      if (
        params.budgetPolicy &&
        !budgetStatus(params.db, params.clock, params.budgetPolicy, params.identity.id).hasHeadroom
      ) {
        transition(params.db, params.clock, params.taskId, { type: "yield_open" });
        break;
      }

      ctx.anchor = homeAnchor(afterSteering);
      effects.length = 0;
      const guidance = queued
        .filter((steer) => steer.kind === "guidance")
        .map((steer) => steer.payload.text ?? "");
      const prompt = params.buildPrompt(turnNum, guidance, toolset);

      turnsRun++;
      const result = await runTurn({
        session,
        threadId,
        cwd: params.cwd,
        prompt,
        title: `${params.taskId}: turn ${turnNum}`,
        db: params.db,
        clock: params.clock,
        turnId: params.newTurnId(),
        identityId: params.identity.id,
        kind: "execution_step",
        executionId: params.executionId,
        anchor: homeAnchor(afterSteering),
        effects,
        tokensUsed,
        spendAmount,
        stallTimeoutMs: params.stallTimeoutMs,
      });

      const after = getTask(params.db, params.taskId);
      if (!after || after.status !== "active") break;

      if (result.status === "failed") {
        interruptOrPark(
          params.db,
          params.clock,
          params.taskId,
          after.consecutiveInterruptions,
          params.maxConsecutiveInterruptions,
        );
        break;
      }
    }
  } finally {
    session.stop();
  }

  const final = getTask(params.db, params.taskId);
  const outcome: ExecutionOutcome = !final
    ? "failed"
    : final.status === "done" || final.status === "failed" || final.status === "cancelled"
      ? final.status
      : final.status === "parked"
        ? "parked"
        : "yielded";
  return { outcome, turnsRun };
}
