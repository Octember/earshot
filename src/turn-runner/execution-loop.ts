// Execution loop: sequential execution_step turns until terminal or yield.
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { getTask, consumeSteering, transition, type Task } from "../ledger/tasks";
import { interruptOrPark } from "../ledger/scheduler";
import { taskSpend, budgetStatus, type BudgetStatusPolicy } from "../policy/budget";
import { buildToolset, type ToolsetContext } from "./toolset";
import { runTurn } from "./turn";
import type { AgentRuntimeSession, DynamicTool } from "./types";
import type { ToolCatalog } from "../policy/broker";
import type { IdentityConfig } from "../policy/schema";
import type { Anchor } from "../ledger/tasks";

export interface ExecutionLoopParams {
  db: Database;
  clock: Clock;
  taskId: string;
  executionId: string;
  identity: IdentityConfig;
  catalog: ToolCatalog;
  cwd: string;
  nudgeAfterMs: number;
  maxTurns: number;
  // Cool-off before re-dispatch after max_turns (avoids livelock).
  maxTurnsBackoffMs: number;
  maxConsecutiveInterruptions: number;
  stallTimeoutMs: number;
  postMessage: (anchor: Anchor, text: string) => Promise<{ messageId: string }>;
  permalink?: ((venueId: string, messageId: string) => string | undefined) | undefined;
  buildPrompt: (turnNumber: number, guidance: string[], tools: DynamicTool[]) => string;
  newTurnId: () => string;
  sessionFactory: (tools: DynamicTool[]) => AgentRuntimeSession;
  tokensUsed?: (() => number) | undefined;
  spendAmount?: (() => number) | undefined;
  // per_task_cap → waiting(human); identity/global → yield_open. Ledger-only.
  perTaskCap?: number | null | undefined;
  budgetPolicy?: BudgetStatusPolicy | undefined;
}

export type ExecutionOutcome = "done" | "failed" | "cancelled" | "yielded" | "parked";

export interface ExecutionLoopResult {
  outcome: ExecutionOutcome;
  turnsRun: number;
}

function outcomeFor(task: Task | null): ExecutionOutcome {
  if (!task) return "failed";
  if (task.status === "done" || task.status === "failed" || task.status === "cancelled")
    return task.status;
  if (task.status === "parked") return "parked";
  return "yielded";
}

export async function runExecution(params: ExecutionLoopParams): Promise<ExecutionLoopResult> {
  const task = getTask(params.db, params.taskId);
  if (!task) throw new Error(`no such task: ${params.taskId}`);

  const effects: unknown[] = [];
  const ctx: ToolsetContext = {
    db: params.db,
    clock: params.clock,
    identity: params.identity,
    turnKind: "execution_step",
    catalog: params.catalog,
    anchor: task.homeAnchor,
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

      // cancel steer already transitioned; consume is acknowledgment.
      const queued = consumeSteering(params.db, params.clock, params.taskId);
      const afterSteering = getTask(params.db, params.taskId);
      if (!afterSteering || afterSteering.status !== "active") break;

      if (turnNum > params.maxTurns) {
        // Cool off on timer — yield_open would livelock.
        const wakeAt = new Date(
          new Date(params.clock()).getTime() + params.maxTurnsBackoffMs,
        ).toISOString();
        transition(params.db, params.clock, params.taskId, "waiting", {
          type: "yield_timer",
          wakeAt,
        });
        break;
      }

      if (params.perTaskCap != null && taskSpend(params.db, params.taskId) >= params.perTaskCap) {
        const nudgeDeadline = new Date(
          new Date(params.clock()).getTime() + params.nudgeAfterMs,
        ).toISOString();
        transition(params.db, params.clock, params.taskId, "waiting", {
          type: "yield_human",
          nudgeDeadline,
        });
        break;
      }

      if (
        params.budgetPolicy &&
        !budgetStatus(params.db, params.clock, params.budgetPolicy, params.identity.id).hasHeadroom
      ) {
        transition(params.db, params.clock, params.taskId, "open", { type: "yield_open" });
        break;
      }

      ctx.anchor = afterSteering.homeAnchor;
      effects.length = 0;
      const guidance = queued
        .filter((steer) => steer.kind === "guidance")
        .map((steer) => (steer.payload as { text?: string }).text ?? "");
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
        anchor: afterSteering.homeAnchor,
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

  return { outcome: outcomeFor(getTask(params.db, params.taskId)), turnsRun };
}
