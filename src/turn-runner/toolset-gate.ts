import type { ActionClass } from "../policy/broker";
import { outwardCallOf, setOutwardCallState } from "../ledger/outward-calls";
import { transition } from "../ledger/tasks-transition";
import { decide, type BrokerDecision } from "../policy/broker";
import type { ToolsetContext } from "./toolset-types";

const DENIAL_MESSAGES: Record<string, string> = {
  confirmation_denied:
    "a human declined exactly this action — it stays declined. Change the approach, or task_fail with what you wanted and why it was refused.",
  not_available_for_turn_kind:
    "denied: not_available_for_turn_kind — this turn is speak-only; the action can run from a task turn or after a member's go-ahead. If you mention this in the room, say it plainly (\"say the word and i'll do it\") — never turn kinds, mutations, or other internals.",
  interactive_consequential_denied:
    "denied: interactive_consequential_denied — this action is consequential and must run inside a task: use task_create and it will proceed there. When you tell the room, say plainly what you're taking on and where you'll report back — never this machinery.",
};

function handleRequiresConfirmation(
  ctx: ToolsetContext,
  toolName: string,
  args: unknown,
  actionClasses: ActionClass[],
): { success: false; output: string } | null {
  if (!ctx.taskId) return null;
  const state = outwardCallOf(ctx.db, ctx.taskId, toolName, args)?.state;
  if (state === "ran")
    return {
      success: false,
      output:
        "already done: this exact call was approved and ran earlier. If you meant a different change, change the arguments.",
    };
  if (state === "pending_approval")
    return {
      success: false,
      output:
        "a go-ahead request is already pending on this task — stop here and end the turn; ask for anything else after it resolves",
    };
  setOutwardCallState(
    ctx.db,
    ctx.clock,
    { identityId: ctx.identity.id, scopeId: ctx.taskId, tool: toolName, args },
    "pending_approval",
    {
      description: `Requesting confirmation to call ${toolName} (${actionClasses.join(", ")}) with ${JSON.stringify(args)}`,
    },
  );
  transition(ctx.db, ctx.clock, ctx.taskId, {
    type: "yield_human",
    nudgeDeadline: new Date(new Date(ctx.clock()).getTime() + ctx.nudgeAfterMs).toISOString(),
  });
  ctx.effects.push({
    kind: "confirmation_requested",
    tool: toolName,
    actionClasses,
  });
  return {
    success: false,
    output: `requires_confirmation: task ${ctx.taskId} is now waiting on a human go-ahead — the request reaches the room through the mind. Stop here and end the turn; do not retry the call and do not reach for outcome tools (the task is paused until the go-ahead resolves).`,
  };
}

function denyToolCall(
  ctx: ToolsetContext,
  toolName: string,
  args: unknown,
  decision: Extract<BrokerDecision, { allow: false }>,
): { success: false; output: string } {
  const fixed = DENIAL_MESSAGES[decision.reason];
  if (fixed) return { success: false, output: fixed };
  if (decision.reason === "requires_confirmation") {
    const pending = handleRequiresConfirmation(ctx, toolName, args, decision.actionClasses);
    if (pending) return pending;
  }
  if (decision.reason === "scope_violation") {
    return { success: false, output: `denied: ${decision.detail}` };
  }
  return { success: false, output: `denied: ${decision.reason}` };
}

export function gateToolCall(
  ctx: ToolsetContext,
  toolName: string,
  args: unknown,
  impl: (args: unknown) => Promise<{ success: boolean; output: string }>,
): Promise<{ success: boolean; output: string }> {
  const decision = decide(ctx.db, ctx.clock, {
    identity: ctx.identity,
    turnKind: ctx.turnKind,
    tool: toolName,
    args,
    catalog: ctx.catalog,
    taskId: ctx.taskId,
  });
  if (!decision.allow) {
    return Promise.resolve(denyToolCall(ctx, toolName, args, decision));
  }
  return impl(args);
}
