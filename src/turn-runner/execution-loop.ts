import type { TurnEffect } from "../schemas/effects";
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { getTask } from "../ledger/tasks-query";
import { transition } from "../ledger/tasks-transition";
import { interrupt } from "../ledger/scheduler";
import { executionToolset } from "./toolset";
import { runTurn } from "./turn";
import type { AppServerSession, DynamicTool } from "@bevyl-ai/agent-tools";
import type { IdentityConfig } from "../policy/schema";
import type { Task } from "../ledger/schema";

export async function runExecution(params: {
  db: Database;
  clock: Clock;
  taskId: string;
  identity: IdentityConfig;
  external: DynamicTool[];
  cwd: string;
  parkAfterMs: number;
  maxTurns: number;
  maxTurnsBackoffMs: number;
  maxInterruptions: number;
  stallTimeoutMs: number;
  buildPrompt: (turnNumber: number) => string;
  sessionFactory: (tools: DynamicTool[]) => AppServerSession;
}): Promise<{ task: Task; turnsRun: number }> {
  const task = getTask(params.db, params.taskId);
  if (!task) throw new Error(`no such task: ${params.taskId}`);

  const effects: TurnEffect[] = [];
  const toolset = executionToolset({
    db: params.db,
    clock: params.clock,
    identity: params.identity,
    external: params.external,
    taskId: params.taskId,
    parkAfterMs: params.parkAfterMs,
    effects,
  });
  const session = params.sessionFactory(toolset);
  await session.start(params.cwd);
  const threadId = await session.startThread(params.cwd);

  let turnsRun = 0;
  try {
    for (let turnNum = 1; ; turnNum++) {
      const current = getTask(params.db, params.taskId);
      if (!current || current.status !== "active") break;
      if (turnNum > params.maxTurns) {
        transition(params.db, params.clock, params.taskId, {
          type: "wait",
          waitingOn: "timer",
          wakeAt: new Date(
            new Date(params.clock()).getTime() + params.maxTurnsBackoffMs,
          ).toISOString(),
        });
        break;
      }
      effects.length = 0;
      turnsRun++;
      const result = await runTurn({
        session,
        threadId,
        cwd: params.cwd,
        prompt: params.buildPrompt(turnNum),
        title: `${params.taskId}: turn ${turnNum}`,
        stallTimeoutMs: params.stallTimeoutMs,
      });
      const after = getTask(params.db, params.taskId);
      if (!after || after.status !== "active") break;
      if (result.status === "failed") {
        interrupt(params.db, params.clock, params.taskId, params.maxInterruptions);
        break;
      }
    }
  } finally {
    session.stop();
  }
  return { task: getTask(params.db, params.taskId) ?? task, turnsRun };
}
