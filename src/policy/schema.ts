export interface SurfaceConfig {
  credentials: Record<string, string>;
}

export interface IdentityConfig {
  id: string;
  persona: string | null;
  venueIds: string[];
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
  models: {
    low: ModelTierConfig;
    medium: ModelTierConfig;
    high: ModelTierConfig;
  };
}
