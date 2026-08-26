// SPEC §16 — policy loading, defaulting, validation, and reload semantics.
import type {
  AmbientConfig,
  BudgetConfig,
  ExecutionsConfig,
  GrantConfig,
  IdentityBudgetConfig,
  IdentityConfig,
  MemoryConfig,
  Policy,
  RetentionConfig,
  SurfaceConfig,
  TasksConfig,
  TurnsConfig,
} from "./schema";
import { readFileSync } from "node:fs";
import { isRecord } from "../guard";

export function parsePolicyYaml(yamlText: string): unknown {
  return Bun.YAML.parse(yamlText);
}

function obj(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strArr(value: unknown): string[] {
  return arr(value).map(String);
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

function numOrNull(value: unknown, fallback: number | null): number | null {
  if (value === null) return null;
  return typeof value === "number" ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function toGrant(raw: unknown): GrantConfig {
  const grant = obj(raw);
  return {
    tool: str(grant.tool, ""),
    scope: isRecord(grant.scope) ? grant.scope : undefined,
    preauthorizedActionClasses: strArr(grant.preauthorized_action_classes),
  };
}

function toAmbient(raw: unknown): AmbientConfig {
  const ambient = obj(raw);
  return {
    eventDebounceMs: num(ambient.event_debounce_ms, 45_000),
  };
}

function toIdentityBudget(raw: unknown): IdentityBudgetConfig {
  const budget = obj(raw);
  return {
    monthlyCap: num(budget.monthly_cap, 0),
    perTaskCap: numOrNull(budget.per_task_cap, null),
  };
}

function toVenueInstructions(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [venueId, text] of Object.entries(obj(raw))) {
    if (typeof text === "string" && text.trim()) out[venueId] = text;
  }
  return out;
}

function toIdentity(raw: unknown): IdentityConfig {
  const identity = obj(raw);
  return {
    id: str(identity.id, ""),
    persona: typeof identity.persona === "string" ? identity.persona : null,
    venueIds: strArr(identity.venue_ids),
    learningSources: strArr(identity.learning_sources),
    grants: arr(identity.grants).map((grantRaw) => toGrant(grantRaw)),
    budget: toIdentityBudget(identity.budget),
    ambient: toAmbient(identity.ambient),
    venueInstructions: toVenueInstructions(identity.venue_instructions),
  };
}

function toSurface(raw: unknown): SurfaceConfig {
  const surface = obj(raw);
  const credsRaw = obj(surface.credentials);
  const credentials: Record<string, string> = {};
  for (const [key, envRef] of Object.entries(credsRaw)) credentials[key] = String(envRef);
  return { kind: str(surface.kind, ""), credentials };
}

function toTurns(raw: unknown): TurnsConfig {
  const turns = obj(raw);
  return {
    interactiveTimeoutMs: num(turns.interactive_timeout_ms, 120_000),
    interactiveTokenCeiling: num(turns.interactive_token_ceiling, 100_000),
    stallTimeoutMs: num(turns.stall_timeout_ms, 45_000),
    historyWindow: num(turns.history_window, 50),
    maxConcurrentInteractive: num(turns.max_concurrent_interactive, 4),
    maxRetries: num(turns.max_retries, 2),
    backoffMs: num(turns.backoff_ms, 5_000),
    batchDebounceMs: num(turns.batch_debounce_ms, 2500),
    batchMaxWaitMs: num(turns.batch_max_wait_ms, 10_000),
  };
}

function toExecutions(raw: unknown): ExecutionsConfig {
  const executions = obj(raw);
  return {
    maxConcurrentPerIdentity: num(executions.max_concurrent_per_identity, 2),
    maxConcurrentGlobal: num(executions.max_concurrent_global, 4),
    progressMaxSilenceMs: num(executions.progress_max_silence_ms, 5 * 60 * 1000),
    maxTurns: num(executions.max_turns, 40),
    stallTimeoutMs: num(executions.stall_timeout_ms, 5 * 60 * 1000),
    maxAttempts: num(executions.max_attempts, 3),
    backoffMs: num(executions.backoff_ms, 30_000),
  };
}

function toTasks(raw: unknown): TasksConfig {
  const tasks = obj(raw);
  return {
    nudgeAfterMs: num(tasks.nudge_after_ms, 24 * 60 * 60 * 1000),
    parkAfterMs: num(tasks.park_after_ms, 48 * 60 * 60 * 1000),
  };
}

function toMemory(raw: unknown): MemoryConfig {
  const memory = obj(raw);
  return {
    coreCharBudget: num(memory.core_char_budget, 8000),
    recentCharBudget: num(memory.recent_char_budget, 2000),
    recentMaxAgeMs: num(memory.recent_max_age_days, 7) * 24 * 60 * 60 * 1000,
  };
}

function toBudget(raw: unknown): BudgetConfig {
  const budget = obj(raw);
  return {
    unit: str(budget.unit, "USD"),
    timezone: str(budget.timezone, "UTC"),
    globalMonthlyCap: num(budget.global_monthly_cap, 0),
    reserve: num(budget.reserve, 0),
    spendConfirmThreshold: num(budget.spend_confirm_threshold, 0),
  };
}

function toRetention(raw: unknown): RetentionConfig {
  const retention = obj(raw);
  return {
    auditRetentionMs: numOrNull(retention.audit_retention_ms, null),
    rawEventRetentionMs: numOrNull(retention.raw_event_retention_ms, null),
  };
}

function toModels(raw: unknown): Policy["models"] {
  const modelsRaw = obj(raw);
  const tier = (tierRaw: unknown) => {
    const tierObj = obj(tierRaw);
    return {
      ...(typeof tierObj.model === "string" ? { model: tierObj.model } : {}),
      ...(typeof tierObj.effort === "string" ? { effort: tierObj.effort } : {}),
    };
  };
  return { low: tier(modelsRaw.low), medium: tier(modelsRaw.medium), high: tier(modelsRaw.high) };
}

export function toPolicy(raw: unknown): Policy {
  const policyRaw = obj(raw);
  return {
    surface: toSurface(policyRaw.surface),
    operatorPrincipals: strArr(policyRaw.operator_principals),
    trustedBotPrincipals: strArr(policyRaw.trusted_bot_principals),
    defaultDmIdentity: typeof policyRaw.default_dm_identity === "string" ? policyRaw.default_dm_identity : null,
    identities: arr(policyRaw.identities).map((identityRaw) => toIdentity(identityRaw)),
    turns: toTurns(policyRaw.turns),
    executions: toExecutions(policyRaw.executions),
    tasks: toTasks(policyRaw.tasks),
    memory: toMemory(policyRaw.memory),
    budget: toBudget(policyRaw.budget),
    retention: toRetention(policyRaw.retention),
    models: toModels(policyRaw.models),
  };
}

export interface PolicyValidationError {
  path: string;
  message: string;
}

export interface ValidateOpts {
  knownTools: Set<string>;
  envAvailable?: (varName: string) => boolean;
  // Known private venues; omitted until surface adapter exists.
  privateVenues?: Set<string>;
}

function defaultEnvAvailable(varName: string): boolean {
  return typeof process.env[varName] === "string" && process.env[varName] !== "";
}

// SPEC §16.3 — startup validation.
export function validatePolicy(policy: Policy, opts: ValidateOpts): PolicyValidationError[] {
  const errors: PolicyValidationError[] = [];
  const envAvailable = opts.envAvailable ?? defaultEnvAvailable;

  for (const [key, ref] of Object.entries(policy.surface.credentials)) {
    if (!ref.startsWith("$")) {
      errors.push({ path: `surface.credentials.${key}`, message: `credential must be a $VAR indirection, got a literal value` });
      continue;
    }
    const varName = ref.slice(1);
    if (!envAvailable(varName)) {
      errors.push({ path: `surface.credentials.${key}`, message: `missing environment variable ${varName}` });
    }
  }

  const venueOwner = new Map<string, string>();
  for (const identity of policy.identities) {
    for (const venueId of identity.venueIds) {
      const existing = venueOwner.get(venueId);
      if (existing && existing !== identity.id) {
        errors.push({
          path: `identities.${identity.id}.venueIds`,
          message: `venue ${venueId} is bound to both ${existing} and ${identity.id}`,
        });
      } else {
        venueOwner.set(venueId, identity.id);
      }
    }
  }

  for (const identity of policy.identities) {
    for (const grant of identity.grants) {
      if (!opts.knownTools.has(grant.tool)) {
        errors.push({ path: `identities.${identity.id}.grants`, message: `unknown tool ${grant.tool}` });
      }
    }
  }

  if (!(policy.budget.globalMonthlyCap >= 0)) {
    errors.push({ path: "budget.globalMonthlyCap", message: `global_monthly_cap must be a non-negative number` });
  }
  for (const identity of policy.identities) {
    if (!(identity.budget.monthlyCap >= 0)) {
      errors.push({ path: `identities.${identity.id}.budget.monthlyCap`, message: `monthly_cap must be a non-negative number` });
    }
    if (identity.budget.perTaskCap !== null && !(identity.budget.perTaskCap >= 0)) {
      errors.push({ path: `identities.${identity.id}.budget.perTaskCap`, message: `per_task_cap must be a non-negative number` });
    }
  }

  if (opts.privateVenues) {
    for (const identity of policy.identities) {
      for (const source of identity.learningSources) {
        if (opts.privateVenues.has(source) && venueOwner.get(source) !== identity.id) {
          errors.push({
            path: `identities.${identity.id}.learningSources`,
            message: `${source} is a private venue not bound to ${identity.id}`,
          });
        }
      }
    }
  }

  return errors;
}

export class PolicyValidationFailedError extends Error {
  constructor(public readonly errors: PolicyValidationError[]) {
    super(`policy validation failed:\n${errors.map((err) => `  ${err.path}: ${err.message}`).join("\n")}`);
    this.name = "PolicyValidationFailedError";
  }
}

export function fileSource(path: string): () => string {
  return () => readFileSync(path, "utf8");
}

// Keep last-known-good on invalid reload.
export class PolicyStore {
  private policy: Policy;
  private lastError: PolicyValidationError[] | null = null;

  constructor(
    private readonly source: () => string,
    private readonly opts: ValidateOpts,
  ) {
    const result = this.loadAndValidate();
    if ("errors" in result) throw new PolicyValidationFailedError(result.errors);
    this.policy = result.policy;
  }

  current(): Policy {
    return this.policy;
  }

  lastReloadError(): PolicyValidationError[] | null {
    return this.lastError;
  }

  reload(): { ok: true } | { ok: false; errors: PolicyValidationError[] } {
    const result = this.loadAndValidate();
    if ("errors" in result) {
      this.lastError = result.errors;
      return { ok: false, errors: result.errors };
    }
    this.lastError = null;
    this.policy = result.policy;
    return { ok: true };
  }

  private loadAndValidate(): { policy: Policy } | { errors: PolicyValidationError[] } {
    let raw: unknown;
    try {
      raw = parsePolicyYaml(this.source());
    } catch (error) {
      return { errors: [{ path: "", message: `failed to read/parse policy: ${error instanceof Error ? error.message : String(error)}` }] };
    }
    const policy = toPolicy(raw);
    const errors = validatePolicy(policy, this.opts);
    return errors.length > 0 ? { errors } : { policy };
  }
}
