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

export function parsePolicyYaml(yamlText: string): unknown {
  return Bun.YAML.parse(yamlText);
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function strArr(v: unknown): string[] {
  return arr(v).map(String);
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" ? v : fallback;
}

function numOrNull(v: unknown, fallback: number | null): number | null {
  if (v === null) return null;
  return typeof v === "number" ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function toGrant(raw: unknown): GrantConfig {
  const g = obj(raw);
  return {
    tool: str(g.tool, ""),
    scope: g.scope && typeof g.scope === "object" ? (g.scope as Record<string, unknown>) : undefined,
    preauthorizedActionClasses: strArr(g.preauthorized_action_classes),
  };
}

function toAmbient(raw: unknown): AmbientConfig {
  const a = obj(raw);
  return {
    enabledVenues: strArr(a.enabled_venues),
    tickIntervalMs: num(a.tick_interval_ms, 30 * 60 * 1000),
    dailyPostCap: num(a.daily_post_cap, 5),
    followupQuietMs: num(a.followup_quiet_ms, 60 * 60 * 1000),
    eventDebounceMs: num(a.event_debounce_ms, 45_000),
  };
}

function toIdentityBudget(raw: unknown): IdentityBudgetConfig {
  const b = obj(raw);
  return {
    monthlyCap: num(b.monthly_cap, 0),
    perTaskCap: numOrNull(b.per_task_cap, null),
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
  const i = obj(raw);
  return {
    id: str(i.id, ""),
    persona: typeof i.persona === "string" ? i.persona : null,
    venueIds: strArr(i.venue_ids),
    learningSources: strArr(i.learning_sources),
    grants: arr(i.grants).map(toGrant),
    budget: toIdentityBudget(i.budget),
    ambient: toAmbient(i.ambient),
    venueInstructions: toVenueInstructions(i.venue_instructions),
  };
}

function toSurface(raw: unknown): SurfaceConfig {
  const s = obj(raw);
  const credsRaw = obj(s.credentials);
  const credentials: Record<string, string> = {};
  for (const [k, v] of Object.entries(credsRaw)) credentials[k] = String(v);
  return { kind: str(s.kind, ""), credentials };
}

function toTurns(raw: unknown): TurnsConfig {
  const t = obj(raw);
  return {
    interactiveTimeoutMs: num(t.interactive_timeout_ms, 120_000),
    interactiveTokenCeiling: num(t.interactive_token_ceiling, 100_000),
    historyWindow: num(t.history_window, 50),
    maxConcurrentInteractive: num(t.max_concurrent_interactive, 4),
    maxRetries: num(t.max_retries, 2),
    batchDebounceMs: num(t.batch_debounce_ms, 2500),
    batchMaxWaitMs: num(t.batch_max_wait_ms, 10_000),
  };
}

function toExecutions(raw: unknown): ExecutionsConfig {
  const e = obj(raw);
  return {
    maxConcurrentPerIdentity: num(e.max_concurrent_per_identity, 2),
    maxConcurrentGlobal: num(e.max_concurrent_global, 4),
    progressMaxSilenceMs: num(e.progress_max_silence_ms, 5 * 60 * 1000),
    maxTurns: num(e.max_turns, 40),
    stallTimeoutMs: num(e.stall_timeout_ms, 5 * 60 * 1000),
    maxAttempts: num(e.max_attempts, 3),
    backoffMs: num(e.backoff_ms, 30_000),
  };
}

function toTasks(raw: unknown): TasksConfig {
  const t = obj(raw);
  return {
    nudgeAfterMs: num(t.nudge_after_ms, 24 * 60 * 60 * 1000),
    parkAfterMs: num(t.park_after_ms, 48 * 60 * 60 * 1000),
  };
}

function toMemory(raw: unknown): MemoryConfig {
  const m = obj(raw);
  return {
    distillationCadenceMs: num(m.distillation_cadence_ms, 24 * 60 * 60 * 1000),
    maxItemsPerIdentity: numOrNull(m.max_items_per_identity, null),
    backfillWindowMs: numOrNull(m.backfill_window_ms, null),
  };
}

function toBudget(raw: unknown): BudgetConfig {
  const b = obj(raw);
  return {
    unit: str(b.unit, "USD"),
    timezone: str(b.timezone, "UTC"),
    globalMonthlyCap: num(b.global_monthly_cap, 0),
    reserve: num(b.reserve, 0),
    spendConfirmThreshold: num(b.spend_confirm_threshold, 0),
  };
}

function toRetention(raw: unknown): RetentionConfig {
  const r = obj(raw);
  return {
    auditRetentionMs: numOrNull(r.audit_retention_ms, null),
    rawEventRetentionMs: numOrNull(r.raw_event_retention_ms, null),
  };
}

export function toPolicy(raw: unknown): Policy {
  const r = obj(raw);
  return {
    surface: toSurface(r.surface),
    operatorPrincipals: strArr(r.operator_principals),
    trustedBotPrincipals: strArr(r.trusted_bot_principals),
    defaultDmIdentity: typeof r.default_dm_identity === "string" ? r.default_dm_identity : null,
    identities: arr(r.identities).map(toIdentity),
    turns: toTurns(r.turns),
    executions: toExecutions(r.executions),
    tasks: toTasks(r.tasks),
    memory: toMemory(r.memory),
    budget: toBudget(r.budget),
    retention: toRetention(r.retention),
  };
}

export interface PolicyValidationError {
  path: string;
  message: string;
}

export interface ValidateOpts {
  knownTools: Set<string>;
  envAvailable?: (varName: string) => boolean;
  // Venues known (from the live surface) to be private. Unavailable before the surface adapter
  // exists (M6); the corresponding §16.3 check is simply skipped when this is omitted.
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
    super(`policy validation failed:\n${errors.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`);
    this.name = "PolicyValidationFailedError";
  }
}

export function fileSource(path: string): () => string {
  return () => require("fs").readFileSync(path, "utf8");
}

// SPEC §16.2 — reload keeps the last-known-good policy on any invalid reload, with an
// operator-visible error rather than a silent fallback or a crash.
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
    } catch (e) {
      return { errors: [{ path: "", message: `failed to read/parse policy: ${e instanceof Error ? e.message : String(e)}` }] };
    }
    const policy = toPolicy(raw);
    const errors = validatePolicy(policy, this.opts);
    return errors.length ? { errors } : { policy };
  }
}
