// SPEC §10.1, §10.2, §10.4, §11 — the (mocked) tool broker: grant allowlist + scope narrowing,
// per-turn-kind toolset restriction, and the action-class confirmation gate. Every decision is
// audit-logged (§10.1's "every tool invocation is audit-logged with the grant decision"), which is
// why decide() takes a db/clock — everything else here is a pure function of its inputs.
import type { Database } from "bun:sqlite";
import type { Clock } from "../ledger/clock";
import { writeAudit } from "../ledger/audit";
import type { IdentityConfig } from "./schema";

export type ActionClass = "irreversible" | "outward" | "spend_above_threshold";

export type TurnKind = "interactive" | "execution_step" | "ambient" | "distillation";

export interface ToolSpec {
  // Which action classes THIS call belongs to — a function of the actual arguments (not a static
  // earshot), since e.g. spend_above_threshold depends on the amount in this specific call.
  actionClasses?: (args: unknown) => ActionClass[];
  scopeCheck?: (scope: Record<string, unknown>, args: unknown) => string | null;
  // The external tool's actual implementation. Absent for built-ins (task_create, reply, ...),
  // whose implementations live in turn-runner/toolset.ts, not the policy layer.
  run?: (args: unknown) => Promise<{ success: boolean; output: string }>;
  // Self-description surfaced to the agent runtime so the model knows how to call the tool. A
  // catalog entry without these gets a generic passthrough schema.
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export type ToolCatalog = Record<string, ToolSpec>;

export type BrokerDecision =
  | { allow: true }
  | { allow: false; reason: "not_granted" }
  | { allow: false; reason: "not_available_for_turn_kind" }
  | { allow: false; reason: "scope_violation"; detail: string }
  | { allow: false; reason: "interactive_consequential_denied"; actionClasses: ActionClass[] }
  | { allow: false; reason: "requires_confirmation"; actionClasses: ActionClass[] }
  | { allow: false; reason: "confirmation_not_eligible" };

export interface GuestPolicyOpts {
  allowGuestConfirmation?: boolean;
}

export interface ToolCallContext {
  identity: IdentityConfig;
  turnKind: TurnKind;
  tool: string;
  args: unknown;
  catalog: ToolCatalog;
  // Required when tool === "task_confirm": task_confirm's eligibility gate (§10.4) is checked
  // HERE, at the same choke point as every other tool decision — not left for a caller to
  // remember to check separately before calling tasks.ts's resolveConfirmation.
  principal?: { isGuest: boolean };
  guestPolicy?: GuestPolicyOpts;
}

type ToolClass = "task_mutating" | "confirm" | "task_read" | "memory_mutating" | "memory_read" | "posting" | "scheduling" | "task_outcome";

// The standard built-in toolset (SPEC §11): ledger tools, memory tools, reply, set_wake, plus
// execution_step's outcome tools (task_complete/task_fail/task_ask — SPEC §6.3/§17.4 describe the
// OUTCOME, not a tool interface; naming them is an implementation-defined choice, documented in
// turn-runner/toolset.ts). External tools (identity grants against the catalog) are unaffected by
// this map — it only classifies the fixed built-ins for the per-turn-kind restrictions below.
const BUILTIN_TOOL_CLASS: Record<string, ToolClass> = {
  task_create: "task_mutating",
  task_steer: "task_mutating",
  task_cancel: "task_mutating",
  task_confirm: "confirm",
  task_query: "task_read",
  memory_write: "memory_mutating",
  memory_retract: "memory_mutating",
  memory_tier: "memory_mutating",
  search: "memory_read", // §8.7: a pure read, available to every turn kind
  reply: "posting",
  set_wake: "scheduling",
  task_complete: "task_outcome",
  task_fail: "task_outcome",
  task_ask: "task_outcome",
  checklist: "posting", // a live progress post; same gating as reply (not for distillation)
  react: "posting", // an emoji reaction is a (lightweight) post — same venues, same turn kinds
};

// Implementation-defined (CLAUDE.md: document the selected behavior where SPEC leaves it open).
// interactive: full standard toolset (§5.3's task_create/task_steer/task_confirm/task_cancel outcomes).
// execution_step: drives its OWN task via yields/effects, not by calling task_create/steer/confirm
// on arbitrary tasks — so no task_mutating/confirm; everything else per §17.4, plus task_outcome
// (its own done/failed/yield declarations).
// ambient: room-facing outputs are posts/reactions only (§9.2) — no task/confirm/scheduling —
// but memory tools are permitted (§8.6): internalizing overheard facts is ambient's core value,
// and a memory write mutates only inward state. Ambient explicit writes land in tier 'recent'.
// distillation: writes memory but posts nothing (§11).
const KIND_BUILTIN_CLASSES: Record<TurnKind, Set<ToolClass>> = {
  interactive: new Set(["task_mutating", "confirm", "task_read", "memory_mutating", "memory_read", "posting", "scheduling"]),
  execution_step: new Set(["task_read", "memory_mutating", "memory_read", "posting", "scheduling", "task_outcome"]),
  ambient: new Set(["task_read", "memory_read", "memory_mutating", "posting"]),
  distillation: new Set(["memory_mutating", "task_read", "memory_read"]),
};

function grantDecision(ctx: ToolCallContext): { grant: IdentityConfig["grants"][number] } | { deny: BrokerDecision } {
  const grant = ctx.identity.grants.find((g) => g.tool === ctx.tool);
  if (!grant) return { deny: { allow: false, reason: "not_granted" } };
  if (grant.scope) {
    const spec = ctx.catalog[ctx.tool];
    // Scope is configured but nothing can check it: fail closed rather than trust the model.
    if (!spec?.scopeCheck) return { deny: { allow: false, reason: "scope_violation", detail: "no scope checker registered for this tool" } };
    const violation = spec.scopeCheck(grant.scope, ctx.args);
    if (violation) return { deny: { allow: false, reason: "scope_violation", detail: violation } };
  }
  return { grant };
}

function actionClassDecision(ctx: ToolCallContext, grant: IdentityConfig["grants"][number]): BrokerDecision {
  const classes = ctx.catalog[ctx.tool]?.actionClasses?.(ctx.args) ?? [];
  const nonPreauthorized = classes.filter((c) => !grant.preauthorizedActionClasses.includes(c));
  if (nonPreauthorized.length === 0) return { allow: true };
  // SPEC §10.2: interactive turns MUST NOT perform a non-preauthorized consequential action at
  // all — the harness denies the tool call outright, forcing the work through a task instead.
  if (ctx.turnKind === "interactive") return { allow: false, reason: "interactive_consequential_denied", actionClasses: nonPreauthorized };
  return { allow: false, reason: "requires_confirmation", actionClasses: nonPreauthorized };
}

export function decide(db: Database, clock: Clock, ctx: ToolCallContext): BrokerDecision {
  const decision = compute(ctx);
  writeAudit(db, clock(), ctx.identity.id, "tool_invoked", {
    tool: ctx.tool,
    turnKind: ctx.turnKind,
    decision: decision.allow ? "allow" : decision.reason,
  });
  return decision;
}

function compute(ctx: ToolCallContext): BrokerDecision {
  // Built-ins (ledger/memory/reply/set_wake) are always part of the standard toolset (§11) — not
  // something an identity is "granted," only restricted by turn kind (ambient/distillation).
  const builtinClass = BUILTIN_TOOL_CLASS[ctx.tool];
  if (builtinClass) {
    if (!KIND_BUILTIN_CLASSES[ctx.turnKind].has(builtinClass)) return { allow: false, reason: "not_available_for_turn_kind" };
    // §10.4: task_confirm's resolution is only ever applied for an eligible principal — checked
    // at this same choke point so it can never be skipped by a caller forgetting to check first.
    if (ctx.tool === "task_confirm" && !confirmationEligible(ctx.principal ?? { isGuest: true }, ctx.guestPolicy)) {
      return { allow: false, reason: "confirmation_not_eligible" };
    }
    return { allow: true };
  }

  // External tools: full grant + scope + action-class pipeline.
  const g = grantDecision(ctx);
  if ("deny" in g) return g.deny;

  // §9.2/§11: ambient turns are speak-only — granted external tools are reachable for reads, but
  // a call carrying any action class (a mutation) is denied even when preauthorized. Ambient may
  // propose the work; the mutation runs in a task.
  if (ctx.turnKind === "ambient") {
    const classes = ctx.catalog[ctx.tool]?.actionClasses?.(ctx.args) ?? [];
    if (classes.length > 0) return { allow: false, reason: "not_available_for_turn_kind" };
  }

  return actionClassDecision(ctx, g.grant);
}

// SPEC §10.4: RECOMMENDED homebrew default — guests may converse but their confirmations of
// consequential actions are not accepted.
export function confirmationEligible(principal: { isGuest: boolean }, opts: GuestPolicyOpts = {}): boolean {
  return !principal.isGuest || (opts.allowGuestConfirmation ?? false);
}
