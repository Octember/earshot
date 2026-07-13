// SPEC §16.1 — the policy file's logical schema. Field names are camelCase here; the YAML on
// disk uses snake_case (mapped in load.ts) to match the SPEC's own naming.

export interface SurfaceConfig {
  kind: string;
  credentials: Record<string, string>; // values are "$VAR" indirections; never inline secrets
}

export interface GrantConfig {
  tool: string;
  scope?: Record<string, unknown>;
  preauthorizedActionClasses: string[];
}

export interface AmbientConfig {
  enabledVenues: string[]; // "*" = every venue the identity observes
  tickIntervalMs: number;
  dailyPostCap: number;
  followupQuietMs: number;
  // Event-driven reactivity: an overheard message arms a debounce; when chatter settles for this
  // long, an ambient turn evaluates whether anything is worth saying (a doc shared, a question it
  // can answer). 0 disables event-driven ambient (timer ticks only).
  eventDebounceMs: number;
}

export interface IdentityBudgetConfig {
  monthlyCap: number;
  perTaskCap: number | null;
}

export interface IdentityConfig {
  id: string;
  persona: string | null;
  venueIds: string[];
  learningSources: string[];
  grants: GrantConfig[];
  budget: IdentityBudgetConfig;
  ambient: AmbientConfig;
  // SPEC §9.5 — operator-set standing instructions per venue ("in this channel do X"), keyed by
  // venue id. Injected into ambient turns (and fresh interactive context) for that venue; also
  // opts the venue into event-driven ambient for bot messages (alert feeds).
  venueInstructions: Record<string, string>;
}

export interface TurnsConfig {
  interactiveTimeoutMs: number;
  interactiveTokenCeiling: number;
  historyWindow: number;
  maxConcurrentInteractive: number;
  maxRetries: number;
  // Base delay between §14.2 wake-retry attempts (doubles per attempt).
  backoffMs: number;
  // SPEC §5.5 quiet-window batching: hold an interactive turn's start until the anchor has been
  // quiet this long (reset per arriving event) so a burst lands as one batch. 0 = no hold.
  batchDebounceMs: number;
  // Upper bound on the hold under sustained chatter — a turn always starts within this.
  batchMaxWaitMs: number;
}

export interface ExecutionsConfig {
  maxConcurrentPerIdentity: number;
  maxConcurrentGlobal: number;
  progressMaxSilenceMs: number;
  maxTurns: number;
  stallTimeoutMs: number;
  maxAttempts: number;
  backoffMs: number;
}

export interface TasksConfig {
  nudgeAfterMs: number;
  parkAfterMs: number;
}

export interface MemoryConfig {
  distillationCadenceMs: number;
  maxItemsPerIdentity: number | null;
  backfillWindowMs: number | null;
  // SPEC §8.6: the injected core must fit this budget; the distiller curates toward it.
  coreCharBudget: number;
}

export interface BudgetConfig {
  unit: string;
  timezone: string;
  globalMonthlyCap: number;
  reserve: number;
  spendConfirmThreshold: number;
}

export interface RetentionConfig {
  auditRetentionMs: number | null;
  rawEventRetentionMs: number | null;
}

// The three smartness tiers a task can run at. Each names a runtime model
// and reasoning effort; absent tiers fall back to the runtime's own config default.
export interface ModelTierConfig {
  model?: string;
  effort?: string;
}
export interface ModelsConfig {
  low: ModelTierConfig;
  medium: ModelTierConfig;
  high: ModelTierConfig;
}

export interface Policy {
  surface: SurfaceConfig;
  operatorPrincipals: string[];
  trustedBotPrincipals: string[];
  // SPEC §7.2: policy MAY name an identity that auto-binds newly seen DM venues.
  defaultDmIdentity: string | null;
  identities: IdentityConfig[];
  turns: TurnsConfig;
  executions: ExecutionsConfig;
  tasks: TasksConfig;
  memory: MemoryConfig;
  budget: BudgetConfig;
  retention: RetentionConfig;
  models: ModelsConfig;
}
