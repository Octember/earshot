export interface SurfaceConfig {
  kind: string;
  credentials: Record<string, string>;
}

export interface GrantConfig {
  tool: string;
  scope?: Record<string, unknown> | undefined;
  preauthorizedActionClasses: string[];
}

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

    stallTimeoutMs: number;
    interactiveTokenCeiling: number;
    maxRetries: number;
    backoffMs: number;
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
