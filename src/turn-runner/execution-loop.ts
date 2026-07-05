// SPEC §17.4 — the execution loop: a sequence of execution_step turns on one long-lived agent
// runtime session, driving one task to a terminal state or a yield. Steering is consumed at each
// turn boundary; max_turns forces a graceful yield; a stalled turn is killed and treated as a
// failed attempt (reusing the SAME interrupted/crash-loop-park mechanism as restart recovery,
// SPEC §14.2 — a same-process crash and a cross-restart crash are both "this execution died
// unexpectedly").
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
  maxConsecutiveInterruptions: number;
  stallTimeoutMs: number;
  postMessage: (anchor: Anchor, text: string) => Promise<{ messageId: string }>;
  updateMessage?: (venueId: string, messageId: string, text: string) => Promise<void>; // for the live checklist
  renderChecklist?: (items: { text: string; done: boolean }[]) => Promise<boolean>; // native task cards on the execution's stream
  buildPrompt: (turnNumber: number, guidance: string[]) => string;
  newTurnId: () => string;
  sessionFactory: (tools: DynamicTool[]) => AgentRuntimeSession;
  tokensUsed?: () => number;
  spendAmount?: () => number;
  // SPEC §10.3: reaching per_task_cap yields to waiting(human) with a visible notice; reaching
  // the identity/global cap defers the task (yields it back to open — the scheduler's own
  // dispatch-time budget check, M3's budgetHeadroomChecker, keeps it there until budget frees up).
  // Both omitted by default — a task with no budget policy attached never budget-yields.
  perTaskCap?: number | null;
  budgetPolicy?: BudgetStatusPolicy;
}

export type ExecutionOutcome = "done" | "failed" | "cancelled" | "yielded" | "parked";

export interface ExecutionLoopResult {
  outcome: ExecutionOutcome;
  turnsRun: number;
}

function outcomeFor(task: Task | null): ExecutionOutcome {
  if (!task) return "failed";
  if (task.status === "done" || task.status === "failed" || task.status === "cancelled") return task.status;
  if (task.status === "parked") return "parked";
  return "yielded"; // open/waiting: the execution ended without terminating the task
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
    updateMessage: params.updateMessage,
    renderChecklist: params.renderChecklist,
    checklist: { messageId: null }, // shared across this execution's turns → one edited-in-place message
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

      // A 'cancel' steer already transitioned the ledger to cancelled synchronously when it was
      // applied (tasks.ts's steerTask); consuming it here is acknowledgment, not action.
      const queued = consumeSteering(params.db, params.clock, params.taskId);
      const afterSteering = getTask(params.db, params.taskId);
      if (!afterSteering || afterSteering.status !== "active") break;

      if (turnNum > params.maxTurns) {
        transition(params.db, params.clock, params.taskId, "open", {
          type: "yield_open",
          // These progress/question texts post to the home anchor (member-facing), so they name
          // the work by title, never the internal task id (SPEC §4.2).
          progress: `"${afterSteering.title}" reached its ${params.maxTurns}-turn bound for this attempt; yielding for a fresh dispatch.`,
        });
        break;
      }

      if (params.perTaskCap != null && taskSpend(params.db, params.taskId) >= params.perTaskCap) {
        const nudgeDeadline = new Date(new Date(params.clock()).getTime() + params.nudgeAfterMs).toISOString();
        transition(params.db, params.clock, params.taskId, "waiting", {
          type: "yield_human",
          question: `"${afterSteering.title}" has reached its per-task budget cap (${params.perTaskCap}); raise the cap, descope, or cancel to continue.`,
          nudgeDeadline,
        });
        break;
      }

      if (params.budgetPolicy && !budgetStatus(params.db, params.clock, params.budgetPolicy, params.identity.id).hasHeadroom) {
        transition(params.db, params.clock, params.taskId, "open", {
          type: "yield_open",
          progress: `"${afterSteering.title}" yielding — identity/global budget cap reached; will resume once budget is available.`,
        });
        break;
      }

      ctx.anchor = afterSteering.homeAnchor; // re-pointed home anchors (if ever supported) apply per turn
      effects.length = 0;
      const guidance = queued.filter((s) => s.kind === "guidance").map((s) => String((s.payload as { text?: string }).text ?? ""));
      const prompt = params.buildPrompt(turnNum, guidance);

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
      if (!after || after.status !== "active") break; // a tool call (task_complete/fail/ask/set_wake, or steering) ended it

      if (result.status === "failed") {
        // The runtime itself crashed or stalled — no tool call resolved the task, so the loop
        // must (SPEC §14.2's interrupted/crash-loop-park mechanism, shared with restart recovery).
        interruptOrPark(params.db, params.clock, params.taskId, after.consecutiveInterruptions, params.maxConsecutiveInterruptions);
        break;
      }
    }
  } finally {
    session.stop();
  }

  return { outcome: outcomeFor(getTask(params.db, params.taskId)), turnsRun };
}
