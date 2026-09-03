// Tool broker: grant allowlist, scope narrowing, per-kind toolset restriction, action-class gate.
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { writeAudit } from "../ledger/audit";
import { getTask } from "../ledger/tasks-query";
import { consumeConfirmation } from "../ledger/tasks-confirmation";
import type { IdentityConfig } from "./schema";
import type { DynamicTool } from "@bevyl-ai/agent-tools";

export type ActionClass = "irreversible" | "outward" | "spend_above_threshold";

// Conversation is one resident wake kind; execution_step for task work; distillation for memory curation.
export type TurnKind = "resident" | "execution_step" | "distillation";

export interface ToolSpec {
  // Action classes from args (e.g. spend_above_threshold depends on amount).
  actionClasses?: (args: unknown) => ActionClass[];
  scopeCheck?: (scope: Record<string, unknown>, args: unknown) => string | null;
  // Absent for built-ins (implementations live in turn-runner/toolset.ts).
  tool?: DynamicTool;
}

export type ToolCatalog = Record<string, ToolSpec>;

export type BrokerDecision =
  | { allow: true }
  | { allow: false; reason: "not_granted" }
  | { allow: false; reason: "confirmation_denied" }
  | { allow: false; reason: "not_available_for_turn_kind" }
  | { allow: false; reason: "scope_violation"; detail: string }
  | { allow: false; reason: "interactive_consequential_denied"; actionClasses: ActionClass[] }
  | { allow: false; reason: "requires_confirmation"; actionClasses: ActionClass[] };

interface ToolCallContext {
  identity: IdentityConfig;
  turnKind: TurnKind;
  tool: string;
  args: unknown;
  catalog: ToolCatalog;
  taskId?: string | undefined; // execution task — redemption scope for approved confirmations
}

type ToolClass =
  | "task_mutating"
  | "confirm"
  | "task_read"
  | "memory_mutating"
  | "memory_read"
  | "posting"
  | "scheduling"
  | "task_outcome"
  | "presence";

const BUILTIN_TOOL_CLASS: Record<string, ToolClass> = {
  task_create: "task_mutating",
  task_steer: "task_mutating",
  task_cancel: "task_mutating",
  task_confirm: "confirm",
  task_query: "task_read",
  memory_write: "memory_mutating",
  memory_retract: "memory_mutating",
  memory_tier: "memory_mutating",
  search: "memory_read",
  reply: "posting",
  set_wake: "scheduling",
  task_complete: "task_outcome",
  task_fail: "task_outcome",
  task_ask: "task_outcome",
  react: "posting",
  step_back: "presence", // leave a conversation; replies there stop being this identity's
};

// resident: conversational set; execution_step: reads + scheduling + outcome; distillation: memory only.
const KIND_BUILTIN_CLASSES: Record<TurnKind, Set<ToolClass>> = {
  resident: new Set([
    "task_mutating",
    "confirm",
    "task_read",
    "memory_mutating",
    "memory_read",
    "posting",
    "presence",
  ]),
  execution_step: new Set(["task_read", "memory_read", "scheduling", "task_outcome"]),
  distillation: new Set(["memory_mutating", "memory_read"]),
};

// Whether a tool is registered with the turn at all. Per-call gate still enforces.
export function exposableForKind(tool: string, kind: TurnKind): boolean {
  const builtinClass = BUILTIN_TOOL_CLASS[tool];
  if (builtinClass) return KIND_BUILTIN_CLASSES[kind].has(builtinClass);
  return true; // external: grants decide presence; action-class gate decides writes
}

function grantDecision(
  ctx: ToolCallContext,
): { grant: IdentityConfig["grants"][number] } | { deny: BrokerDecision } {
  const grant = ctx.identity.grants.find((grantEntry) => grantEntry.tool === ctx.tool);
  if (!grant) return { deny: { allow: false, reason: "not_granted" } };
  if (grant.scope) {
    const spec = ctx.catalog[ctx.tool];
    // Scope configured but no checker: fail closed.
    if (!spec?.scopeCheck)
      return {
        deny: {
          allow: false,
          reason: "scope_violation",
          detail: "no scope checker registered for this tool",
        },
      };
    const violation = spec.scopeCheck(grant.scope, ctx.args);
    if (violation) return { deny: { allow: false, reason: "scope_violation", detail: violation } };
  }
  return { grant };
}

function actionClassDecision(
  ctx: ToolCallContext,
  grant: IdentityConfig["grants"][number],
): BrokerDecision {
  const classes = ctx.catalog[ctx.tool]?.actionClasses?.(ctx.args) ?? [];
  const nonPreauthorized = classes.filter(
    (actionClass) => !grant.preauthorizedActionClasses.includes(actionClass),
  );
  if (nonPreauthorized.length === 0) return { allow: true };
  // Resident MUST NOT perform non-preauthorized consequential actions — force through a task.
  if (ctx.turnKind === "resident")
    return {
      allow: false,
      reason: "interactive_consequential_denied",
      actionClasses: nonPreauthorized,
    };
  return { allow: false, reason: "requires_confirmation", actionClasses: nonPreauthorized };
}

// Sorted keys at every level so approved-call refs match retries regardless of property order.
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).toSorted(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function actionRefFor(tool: string, args: unknown): string {
  return `${tool}:${canonicalJson(args)}`;
}

export function decide(db: Database, clock: Clock, ctx: ToolCallContext): BrokerDecision {
  let decision = compute(ctx);
  // Approval is single-use, bound to the exact action; burn before the call so failures re-ask.
  if (!decision.allow && decision.reason === "requires_confirmation" && ctx.taskId) {
    const task = getTask(db, ctx.taskId);
    const pendingConfirmation = task?.pendingConfirmation;
    if (
      pendingConfirmation &&
      pendingConfirmation.actionRef === actionRefFor(ctx.tool, ctx.args) &&
      pendingConfirmation.resolution &&
      !pendingConfirmation.consumedAt
    ) {
      if (pendingConfirmation.resolution.approved) {
        consumeConfirmation(db, clock, ctx.taskId);
        decision = { allow: true };
      } else {
        decision = { allow: false, reason: "confirmation_denied" };
      }
    }
  }
  writeAudit(db, clock(), ctx.identity.id, {
    kind: "tool_invoked",
    payload: {
      tool: ctx.tool,
      turnKind: ctx.turnKind,
      decision: decision.allow ? "allow" : decision.reason,
    },
  });
  return decision;
}

function compute(ctx: ToolCallContext): BrokerDecision {
  const builtinClass = BUILTIN_TOOL_CLASS[ctx.tool];
  if (builtinClass) {
    if (!KIND_BUILTIN_CLASSES[ctx.turnKind].has(builtinClass))
      return { allow: false, reason: "not_available_for_turn_kind" };
    return { allow: true };
  }

  const grantResult = grantDecision(ctx);
  if ("deny" in grantResult) return grantResult.deny;

  return actionClassDecision(ctx, grantResult.grant);
}

// No guest confirmation — adapter has no guest signal.
