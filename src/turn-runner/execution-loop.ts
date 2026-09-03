import type { TurnEffect } from "../schemas/effects";

import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { getTask } from "../ledger/tasks-query";
import { transition } from "../ledger/tasks-transition";
import { homeAnchor } from "../ledger/tasks-types";
import { interruptOrPark } from "../ledger/scheduler";
import { buildToolset } from "./toolset";
import { makeRefTable } from "../ledger/conversations-refs";
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
  parkAfterMs: number;
  maxTurns: number;

  maxTurnsBackoffMs: number;
  maxConsecutiveInterruptions: number;
  stallTimeoutMs: number;
  postMessage: (anchor: Anchor, text: string) => Promise<{ messageId: string }>;
  permalink: (venueId: string, messageId: string) => string | undefined;
  recentCharBudget: number;
  buildPrompt: (turnNumber: number, tools: DynamicTool[]) => string;
  newTurnId: () => string;
  sessionFactory: (tools: DynamicTool[]) => AppServerSession;
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
    parkAfterMs: params.parkAfterMs,
    postMessage: params.postMessage,
    permalink: params.permalink,
    recentCharBudget: params.recentCharBudget,
    refs: makeRefTable(),
    effects,
  };
  const toolset = buildToolset(ctx);
  const session = params.sessionFactory(toolset);
  await session.start(params.cwd);
  const threadId = await session.startThread(params.cwd);

  let turnsRun = 0;
  try {
    for (let turnNum = 1; ; turnNum++) {
      const current = getTask(params.db, params.taskId);
      if (!current || current.status !== "active") break;

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

      ctx.anchor = homeAnchor(current);
      effects.length = 0;
      const prompt = params.buildPrompt(turnNum, toolset);

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
        anchor: homeAnchor(current),
        effects,
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
