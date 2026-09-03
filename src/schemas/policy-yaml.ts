import { z } from "zod";
import {
  looseNumber,
  looseNumberOrNull,
  looseRecord,
  looseString,
  looseStringArray,
} from "./common";
import type { GrantConfig, IdentityConfig, Policy, SurfaceConfig } from "../policy/schema";

const GrantYamlSchema = z
  .object({
    tool: z.unknown().optional(),
    scope: z.unknown().optional(),
    preauthorized_action_classes: z.unknown().optional(),
  })
  .transform((grant): GrantConfig => ({
    tool: typeof grant.tool === "string" ? grant.tool : "",
    scope: z.record(z.string(), z.unknown()).safeParse(grant.scope).success
      ? z.record(z.string(), z.unknown()).parse(grant.scope)
      : undefined,
    preauthorizedActionClasses: looseStringArray().parse(grant.preauthorized_action_classes),
  }));

const IdentityYamlSchema = z
  .object({
    id: z.unknown().optional(),
    persona: z.unknown().optional(),
    venue_ids: z.unknown().optional(),
    grants: z.unknown().optional(),
    budget: z.unknown().optional(),
    ambient: z.unknown().optional(),
    venue_instructions: z.unknown().optional(),
  })
  .transform((identity): IdentityConfig => {
    const budget = looseRecord().parse(identity.budget);
    const ambient = looseRecord().parse(identity.ambient);
    const venueInstructionsRaw = looseRecord().parse(identity.venue_instructions);
    const venueInstructions: Record<string, string> = {};
    for (const [venueId, text] of Object.entries(venueInstructionsRaw)) {
      if (typeof text === "string" && text.trim()) venueInstructions[venueId] = text;
    }
    return {
      id: typeof identity.id === "string" ? identity.id : "",
      persona: typeof identity.persona === "string" ? identity.persona : null,
      venueIds: looseStringArray().parse(identity.venue_ids),
      grants: (Array.isArray(identity.grants) ? identity.grants : []).map((grant) =>
        GrantYamlSchema.parse(grant),
      ),
      budget: {
        monthlyCap: looseNumber(0).parse(budget.monthly_cap),
        perTaskCap: looseNumberOrNull(null).parse(budget.per_task_cap),
      },
      ambient: {
        eventDebounceMs: looseNumber(45_000).parse(ambient.event_debounce_ms),
      },
      venueInstructions,
    };
  });

const SurfaceYamlSchema = z
  .object({
    kind: z.unknown().optional(),
    credentials: z.unknown().optional(),
  })
  .transform((surface): SurfaceConfig => {
    const credsRaw = looseRecord().parse(surface.credentials);
    const credentials: Record<string, string> = {};
    for (const [key, envRef] of Object.entries(credsRaw)) credentials[key] = String(envRef);
    return {
      kind: typeof surface.kind === "string" ? surface.kind : "",
      credentials,
    };
  });

const ModelTierYamlSchema = z
  .object({
    model: z.unknown().optional(),
    effort: z.unknown().optional(),
  })
  .transform((tier) => ({
    ...(typeof tier.model === "string" ? { model: tier.model } : {}),
    ...(typeof tier.effort === "string" ? { effort: tier.effort } : {}),
  }));

export const PolicyYamlSchema = z
  .object({
    surface: z.unknown().optional(),
    trusted_bot_principals: z.unknown().optional(),
    default_dm_identity: z.unknown().optional(),
    identities: z.unknown().optional(),
    turns: z.unknown().optional(),
    executions: z.unknown().optional(),
    tasks: z.unknown().optional(),
    memory: z.unknown().optional(),
    budget: z.unknown().optional(),
    models: z.unknown().optional(),
  })
  .transform((policyRaw): Policy => {
    const turns = looseRecord().parse(policyRaw.turns);
    const executions = looseRecord().parse(policyRaw.executions);
    const tasks = looseRecord().parse(policyRaw.tasks);
    const memory = looseRecord().parse(policyRaw.memory);
    const budget = looseRecord().parse(policyRaw.budget);
    const modelsRaw = looseRecord().parse(policyRaw.models);
    return {
      surface: SurfaceYamlSchema.parse(policyRaw.surface),
      trustedBotPrincipals: looseStringArray().parse(policyRaw.trusted_bot_principals),
      defaultDmIdentity:
        typeof policyRaw.default_dm_identity === "string" ? policyRaw.default_dm_identity : null,
      identities: (Array.isArray(policyRaw.identities) ? policyRaw.identities : []).map(
        (identity) => IdentityYamlSchema.parse(identity),
      ),
      turns: {
        interactiveTimeoutMs: looseNumber(120_000).parse(turns.interactive_timeout_ms),
        interactiveTokenCeiling: looseNumber(100_000).parse(turns.interactive_token_ceiling),
        stallTimeoutMs: looseNumber(45_000).parse(turns.stall_timeout_ms),
        maxRetries: looseNumber(2).parse(turns.max_retries),
        backoffMs: looseNumber(5_000).parse(turns.backoff_ms),
      },
      executions: {
        maxConcurrentPerIdentity: looseNumber(2).parse(executions.max_concurrent_per_identity),
        maxConcurrentGlobal: looseNumber(4).parse(executions.max_concurrent_global),
        maxTurns: looseNumber(40).parse(executions.max_turns),
        stallTimeoutMs: looseNumber(5 * 60 * 1000).parse(executions.stall_timeout_ms),
        maxAttempts: looseNumber(3).parse(executions.max_attempts),
        backoffMs: looseNumber(30_000).parse(executions.backoff_ms),
      },
      tasks: {
        nudgeAfterMs: looseNumber(24 * 60 * 60 * 1000).parse(tasks.nudge_after_ms),
        parkAfterMs: looseNumber(48 * 60 * 60 * 1000).parse(tasks.park_after_ms),
      },
      memory: {
        coreCharBudget: looseNumber(8000).parse(memory.core_char_budget),
        recentCharBudget: looseNumber(2000).parse(memory.recent_char_budget),
        recentMaxAgeMs: looseNumber(7).parse(memory.recent_max_age_days) * 24 * 60 * 60 * 1000,
      },
      budget: {
        unit: looseString("USD").parse(budget.unit),
        timezone: looseString("UTC").parse(budget.timezone),
        globalMonthlyCap: looseNumber(0).parse(budget.global_monthly_cap),
        reserve: looseNumber(0).parse(budget.reserve),
      },
      models: {
        low: ModelTierYamlSchema.parse(modelsRaw.low ?? {}),
        medium: ModelTierYamlSchema.parse(modelsRaw.medium ?? {}),
        high: ModelTierYamlSchema.parse(modelsRaw.high ?? {}),
      },
    };
  });

export function parsePolicy(raw: unknown): Policy {
  return PolicyYamlSchema.parse(raw ?? {});
}
