import { z } from "zod";
import type { Policy } from "../policy/schema";

const num = (fallback: number) => z.number().catch(fallback);
const str = z.string().catch("");
const strings = z.array(z.coerce.string()).catch([]);
const record = z.record(z.string(), z.unknown()).catch({});

const Identity = z.object({
  id: str,
  persona: z.string().nullable().catch(null),
  venue_ids: strings,
  ambient: z.object({ event_debounce_ms: num(45_000) }).catch({ event_debounce_ms: 45_000 }),
  venue_instructions: z.record(z.string(), z.unknown()).catch({}),
});

const ModelTier = z
  .object({ model: z.string().optional(), effort: z.string().optional() })
  .catch({});

const tier = (t: z.infer<typeof ModelTier>) => ({
  ...(t.model === undefined ? {} : { model: t.model }),
  ...(t.effort === undefined ? {} : { effort: t.effort }),
});

export const PolicyYamlSchema = z
  .object({
    surface: z.object({ credentials: record }).catch({ credentials: {} }),
    trusted_bot_principals: strings,
    default_dm_identity: z.string().nullable().catch(null),
    identities: z.array(Identity).catch([]),
    turns: z
      .object({
        interactive_timeout_ms: num(120_000),
        stall_timeout_ms: num(45_000),
        max_retries: num(2),
        backoff_ms: num(5_000),
      })
      .catch({
        interactive_timeout_ms: 120_000,
        stall_timeout_ms: 45_000,
        max_retries: 2,
        backoff_ms: 5_000,
      }),
    executions: z
      .object({
        max_concurrent_per_identity: num(2),
        max_concurrent_global: num(4),
        max_turns: num(40),
        stall_timeout_ms: num(5 * 60 * 1000),
        max_attempts: num(3),
        backoff_ms: num(30_000),
      })
      .catch({
        max_concurrent_per_identity: 2,
        max_concurrent_global: 4,
        max_turns: 40,
        stall_timeout_ms: 5 * 60 * 1000,
        max_attempts: 3,
        backoff_ms: 30_000,
      }),
    tasks: z
      .object({ park_after_ms: num(48 * 60 * 60 * 1000) })
      .catch({ park_after_ms: 48 * 60 * 60 * 1000 }),
    memory: z.object({ core_char_budget: num(8000) }).catch({ core_char_budget: 8000 }),
    models: z
      .object({ low: ModelTier, medium: ModelTier, high: ModelTier })
      .catch({ low: {}, medium: {}, high: {} }),
  })
  .transform((raw): Policy => ({
    surface: {
      credentials: Object.fromEntries(
        Object.entries(raw.surface.credentials).map(([key, value]) => [key, String(value)]),
      ),
    },
    trustedBotPrincipals: raw.trusted_bot_principals,
    defaultDmIdentity: raw.default_dm_identity,
    identities: raw.identities.map((identity) => ({
      id: identity.id,
      persona: identity.persona,
      venueIds: identity.venue_ids,
      ambient: { eventDebounceMs: identity.ambient.event_debounce_ms },
      venueInstructions: Object.fromEntries(
        Object.entries(identity.venue_instructions).flatMap(([venueId, text]) =>
          typeof text === "string" && text.trim() ? [[venueId, text]] : [],
        ),
      ),
    })),
    turns: {
      interactiveTimeoutMs: raw.turns.interactive_timeout_ms,
      stallTimeoutMs: raw.turns.stall_timeout_ms,
      maxRetries: raw.turns.max_retries,
      backoffMs: raw.turns.backoff_ms,
    },
    executions: {
      maxConcurrentPerIdentity: raw.executions.max_concurrent_per_identity,
      maxConcurrentGlobal: raw.executions.max_concurrent_global,
      maxTurns: raw.executions.max_turns,
      stallTimeoutMs: raw.executions.stall_timeout_ms,
      maxAttempts: raw.executions.max_attempts,
      backoffMs: raw.executions.backoff_ms,
    },
    tasks: { parkAfterMs: raw.tasks.park_after_ms },
    memory: { coreCharBudget: raw.memory.core_char_budget },
    models: {
      low: tier(raw.models.low),
      medium: tier(raw.models.medium),
      high: tier(raw.models.high),
    },
  }));
