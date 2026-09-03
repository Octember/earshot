export interface SurfaceConfig {
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
    parkAfterMs: number;
  };
  memory: {
    coreCharBudget: number;
    recentCharBudget: number;
    recentMaxAgeMs: number;
  };
  models: {
    low: ModelTierConfig;
    medium: ModelTierConfig;
    high: ModelTierConfig;
  };
}
