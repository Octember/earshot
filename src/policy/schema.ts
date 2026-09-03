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
export interface IdentityConfig {
  id: string;
  persona: string | null;
  venueIds: string[];
  grants: GrantConfig[];
  budget: {
    monthlyCap: number;
    perTaskCap: number | null;
  };
  ambient: {
    eventDebounceMs: number;
  };
  // Per-venue standing instructions, keyed by venue id.
  venueInstructions: Record<string, string>;
}

interface ModelTierConfig {
  model?: string;
  effort?: string;
}
export interface Policy {
  surface: SurfaceConfig;
  trustedBotPrincipals: string[];
  defaultDmIdentity: string | null;
  identities: IdentityConfig[];
  turns: {
    interactiveTimeoutMs: number;
    // Idle (no activity) bound; envelope bounds total work — different jobs.
    stallTimeoutMs: number;
    interactiveTokenCeiling: number;
    maxRetries: number;
    backoffMs: number;
    // Quiet-window batching; 0 = no hold.
  };
  executions: {
    maxConcurrentPerIdentity: number;
    maxConcurrentGlobal: number;
    maxTurns: number;
    stallTimeoutMs: number;
    maxAttempts: number;
    backoffMs: number;
  };
  tasks: {
    nudgeAfterMs: number;
    parkAfterMs: number;
  };
  memory: {
    coreCharBudget: number;
    recentCharBudget: number;
    recentMaxAgeMs: number;
  };
  budget: {
    unit: string;
    timezone: string;
    globalMonthlyCap: number;
    reserve: number;
  };
  models: {
    low: ModelTierConfig;
    medium: ModelTierConfig;
    high: ModelTierConfig;
  };
}
