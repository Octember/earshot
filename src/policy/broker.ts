import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { writeAudit } from "../ledger/audit";
import type { IdentityConfig } from "./schema";
import type { DynamicTool } from "@bevyl-ai/agent-tools";

export type ActionClass = "irreversible" | "outward" | "spend_above_threshold";

export type TurnKind = "resident" | "execution_step" | "distillation";

export interface ToolSpec {
  actionClasses?: (args: unknown) => ActionClass[];
  scopeCheck?: (scope: Record<string, unknown>, args: unknown) => string | null;

  tool?: DynamicTool;
}

export type ToolCatalog = Record<string, ToolSpec>;

export type BrokerDecision =
  | { allow: true }
  | { allow: false; reason: "not_granted" }
  | { allow: false; reason: "not_available_for_turn_kind" }
  | { allow: false; reason: "scope_violation"; detail: string };

interface ToolCallContext {
  identity: IdentityConfig;
  turnKind: TurnKind;
  tool: string;
  args: unknown;
  catalog: ToolCatalog;
  taskId?: string | undefined;
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
  step_back: "presence",
};

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

export function exposableForKind(tool: string, kind: TurnKind): boolean {
  const builtinClass = BUILTIN_TOOL_CLASS[tool];
  if (builtinClass) return KIND_BUILTIN_CLASSES[kind].has(builtinClass);
  return true;
}

function grantDecision(
  ctx: ToolCallContext,
): { grant: IdentityConfig["grants"][number] } | { deny: BrokerDecision } {
  const grant = ctx.identity.grants.find((grantEntry) => grantEntry.tool === ctx.tool);
  if (!grant) return { deny: { allow: false, reason: "not_granted" } };
  if (grant.scope) {
    const spec = ctx.catalog[ctx.tool];

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

export function decide(db: Database, clock: Clock, ctx: ToolCallContext): BrokerDecision {
  const decision = compute(ctx);

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

  return { allow: true };
}
