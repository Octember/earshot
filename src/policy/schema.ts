// Policy file logical schema (camelCase here; YAML snake_case mapped in load.ts).

export interface SurfaceConfig {
  kind: string;
  credentials: Record<string, string>; // values are "$VAR" indirections; never inline secrets
}

export interface GrantConfig {
  tool: string;
  scope?: Record<string, unknown> | undefined;
  preauthorizedActionClasses: string[];
}

// Post-Collapse, "ambient" survives only as the settle debounce feeding the EAR: an overheard
// message arms it; when chatter settles this long, an attention pass judges whether to wake.
// tick/post-cap/venue knobs the pre-Collapse ambient turns read were deleted 2026-08-13 (dead
// since the resident loop absorbed ambient; nothing consumed them).
export interface AmbientConfig {
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
  // Idle bound for envelope turns: a turn with NO runtime activity for this long is killed as a
  // failed attempt (retryable) instead of burning the whole envelope. The envelope bounds honest
  // work; this bounds a dead runtime — one number cannot do both jobs (2026-07-27, 2026-08-10).
  stallTimeoutMs: number;
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
  // SPEC §8.6: the injected core must fit this budget; the distiller curates toward it.
  coreCharBudget: number;
  // §8.6: recent-tier items ride standing instructions under a smaller budget, labeled unvetted.
  recentCharBudget: number;
  // §8.6: recent items unconfirmed past this age auto-demote to archive (decay is demotion).
  recentMaxAgeMs: number;
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
