// Policy logical schema (camelCase; YAML snake_case mapped in load.ts).

export interface SurfaceConfig {
  kind: string;
  credentials: Record<string, string>; // values are "$VAR" indirections; never inline secrets
}

export interface GrantConfig {
  tool: string;
  scope?: Record<string, unknown> | undefined;
  preauthorizedActionClasses: string[];
}

// Settle debounce before an attention pass judges whether to wake.
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
  grants: GrantConfig[];
  budget: IdentityBudgetConfig;
  ambient: AmbientConfig;
  // Per-venue standing instructions, keyed by venue id.
  venueInstructions: Record<string, string>;
}

export interface TurnsConfig {
  interactiveTimeoutMs: number;
  // Idle (no activity) bound; envelope bounds total work — different jobs.
  stallTimeoutMs: number;
  interactiveTokenCeiling: number;
  maxRetries: number;
  backoffMs: number;
  // Quiet-window batching; 0 = no hold.
}

export interface ExecutionsConfig {
  maxConcurrentPerIdentity: number;
  maxConcurrentGlobal: number;
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
  coreCharBudget: number;
  recentCharBudget: number;
  recentMaxAgeMs: number;
}

export interface BudgetConfig {
  unit: string;
  timezone: string;
  globalMonthlyCap: number;
  reserve: number;
}

interface ModelTierConfig {
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
  trustedBotPrincipals: string[];
  defaultDmIdentity: string | null;
  identities: IdentityConfig[];
  turns: TurnsConfig;
  executions: ExecutionsConfig;
  tasks: TasksConfig;
  memory: MemoryConfig;
  budget: BudgetConfig;
  models: ModelsConfig;
}
