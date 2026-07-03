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
  enabledVenues: string[];
  tickIntervalMs: number;
  dailyPostCap: number;
  followupQuietMs: number;
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
}

export interface TurnsConfig {
  ackTimeoutMs: number;
  interactiveTimeoutMs: number;
  interactiveTokenCeiling: number;
  historyWindow: number;
  maxConcurrentInteractive: number;
  maxRetries: number;
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
}
